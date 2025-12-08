import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, Constants, PermissionStore, PermissionsBits, RestAPI, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "Delay in milliseconds between each message deletion (recommended: 100-500 to avoid rate limits)",
        default: 200
    }
});

interface Message {
    id: string;
    author: {
        id: string;
    };
    timestamp: string;
}

interface ActivePurge {
    stop: boolean;
    deleted: number;
    failed: number;
}

interface PendingConfirmation {
    count: number;
    userId?: string;
    mode: "self" | "user";
}

// State management
const activePurges = new Map<string, ActivePurge>();
const pendingConfirmations = new Map<string, PendingConfirmation>();
const activeScans = new Map<string, { stop: boolean }>();

// Helper function to sleep
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if channel is a DM
function isDM(channelId: string): boolean {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return false;
    // DM channels have type 1, group DMs have type 3
    return channel.type === 1 || channel.type === 3;
}

// Check if user can manage messages in channel
function canManageMessages(channelId: string): boolean {
    if (isDM(channelId)) return false;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return false;
    return PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel);
}

// Discover messages with comprehensive pagination
async function discoverMessages(
    channelId: string,
    options: {
        userId?: string;
        afterId?: string;
        beforeId?: string;
        limit?: number;
        onProgress?: (count: number) => void;
    }
): Promise<Message[]> {
    const messages: Message[] = [];
    let lastMessageId: string | undefined;
    const { userId, afterId, beforeId, limit, onProgress } = options;
    
    // Check if scan should stop
    const scanState = activeScans.get(channelId);
    if (scanState?.stop) {
        activeScans.delete(channelId);
        return messages;
    }

    // If afterId or beforeId is specified, we need to find those messages
    // Messages are returned newest first: [newest, msg2, msg3, ..., oldest]
    // - Messages "after" a message ID are NEWER (appear before it in response)
    // - Messages "before" a message ID are OLDER (appear after it in response)
    if (afterId || beforeId) {
        let collecting = false; // Whether we're currently collecting messages
        let foundBoundary = false; // Whether we've found the boundary message
        
        // For "after" command: start collecting immediately (we want newer messages)
        if (afterId && !beforeId) {
            collecting = true;
        }

        // Fetch messages starting from newest
        while (true) {
            // Check if scan should stop
            const scanState = activeScans.get(channelId);
            if (scanState?.stop) {
                activeScans.delete(channelId);
                break;
            }
            
            // Check if purge should stop (for after/before commands that use discovery)
            const purgeState = activePurges.get(channelId);
            if (purgeState?.stop) {
                break;
            }

            const query: Record<string, string> = { limit: "100" };
            if (lastMessageId) {
                query.before = lastMessageId;
            }

            try {
                const response = await RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    query
                });

                const batch = response.body as Message[];
                if (!batch || batch.length === 0) {
                    break; // No more messages
                }

                // Process messages (newest first)
                for (const msg of batch) {
                    // Check if purge should stop (check in inner loop for responsiveness)
                    const purgeState = activePurges.get(channelId);
                    if (purgeState?.stop) {
                        break;
                    }
                    
                    // For "after" command (only afterId, no beforeId): we want messages NEWER than afterId
                    // These appear BEFORE afterId in the response (they're newer)
                    // We're already collecting, so check if this is the boundary
                    if (afterId && !beforeId && msg.id === afterId) {
                        // Found the after boundary, stop collecting (we've collected all newer messages)
                        foundBoundary = true;
                        collecting = false;
                        lastMessageId = msg.id;
                        break; // Exit the for loop, we're done
                    }

                    // For "before" command (only beforeId, no afterId): we want messages OLDER than beforeId
                    // These appear AFTER beforeId in the response (they're older)
                    // So we find beforeId first, then start collecting
                    if (beforeId && !afterId) {
                        if (!foundBoundary) {
                            // Still searching for beforeId
                            if (msg.id === beforeId) {
                                // Found the before boundary, start collecting OLDER messages (next in batch and future batches)
                                collecting = true;
                                foundBoundary = true;
                                // Don't include this message itself, start collecting from next (older)
                                lastMessageId = msg.id;
                                continue; // Skip this message, move to next (older)
                            } else {
                                // Haven't found beforeId yet, just update lastMessageId for pagination
                                lastMessageId = msg.id;
                                continue; // Skip this message, keep looking for beforeId
                            }
                        }
                        // If we've found beforeId, we're collecting - fall through to collection logic
                    }

                    // For range (both afterId and beforeId):
                    // - afterId is the newer boundary (stop collecting when found - we've collected all newer)
                    // - beforeId is the older boundary (start collecting when found)
                    if (afterId && beforeId) {
                        // Start collecting when we find beforeId (older boundary)
                        if (msg.id === beforeId) {
                            collecting = true;
                            foundBoundary = true;
                            lastMessageId = msg.id;
                            continue;
                        }
                        // Stop collecting when we find afterId (newer boundary)
                        if (msg.id === afterId) {
                            collecting = false;
                            foundBoundary = true;
                            lastMessageId = msg.id;
                            break; // Exit the for loop, we're done
                        }
                    }

                    // If we're collecting, add this message
                    if (collecting) {
                        // Filter by userId if specified
                        if (!userId || msg.author?.id === userId) {
                            messages.push(msg);
                        }
                    }

                    lastMessageId = msg.id;
                }

                // If we found afterId (in after-only or range mode), we're done
                if (afterId && foundBoundary && !collecting) {
                    break;
                }
                
                // If we found beforeId in range mode and stopped collecting, we're done
                if (afterId && beforeId && foundBoundary && !collecting) {
                    break;
                }

                // For "before" command: if we've searched through all messages and haven't found beforeId, we're done
                if (beforeId && !afterId && !foundBoundary && batch.length < 100) {
                    // Reached the end without finding beforeId, return empty
                    break;
                }

                // If we got less than 100 messages, we've reached the end
                if (batch.length < 100) {
                    break;
                }

                // Small delay to avoid rate limiting
                await sleep(100);
            } catch (error) {
                console.error("[PurgeMessages] Error during message discovery:", error);
                break;
            }
        }

        // Clean up scan state
        activeScans.delete(channelId);
        
        // Return collected messages
        return messages;
    }

    // Normal discovery without afterId
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;
    let lastSuccessfulBatchSize = 0;
    
    while (true) {
        // Check if scan should stop
        const scanState = activeScans.get(channelId);
        if (scanState?.stop) {
            activeScans.delete(channelId);
            break;
        }
        
        // If we have a limit and enough messages, break
        if (limit && messages.length >= limit) {
            break;
        }

        const query: Record<string, string> = { limit: "100" };
        if (lastMessageId) {
            query.before = lastMessageId;
        }

        let batch: Message[] = [];
        let success = false;
        
        // Retry logic for robust scanning
        for (let retry = 0; retry < 3; retry++) {
            try {
                const response = await RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    query
                });

                batch = response.body as Message[];
                success = true;
                consecutiveErrors = 0;
                break; // Success, exit retry loop
            } catch (error) {
                console.error(`[PurgeMessages] Error during message discovery (attempt ${retry + 1}/3):`, error);
                
                // If it's a rate limit error, wait longer
                if (error && typeof error === "object" && "status" in error && error.status === 429) {
                    const retryAfter = (error as any).retry_after || 1000;
                    await sleep(retryAfter * (retry + 1));
                } else {
                    await sleep(500 * (retry + 1)); // Exponential backoff
                }
            }
        }

        if (!success) {
            consecutiveErrors++;
            if (consecutiveErrors >= maxConsecutiveErrors) {
                console.error("[PurgeMessages] Too many consecutive errors, stopping discovery");
                break;
            }
            // Try to continue with last known message ID
            continue;
        }

        if (!batch || batch.length === 0) {
            // No more messages - but verify by checking if we got a full batch last time
            // Sometimes Discord returns empty but there are more messages
            if (lastSuccessfulBatchSize === 100) {
                // Last batch was full, might be a temporary issue
                await sleep(500);
                continue;
            }
            break; // Truly no more messages
        }

        lastSuccessfulBatchSize = batch.length;

        // Process ALL messages in the batch (newest first)
        // We need to process every message to ensure proper pagination
        for (const msg of batch) {
            // Check if scan should stop
            const scanState = activeScans.get(channelId);
            if (scanState?.stop) {
                activeScans.delete(channelId);
                return messages;
            }
            
            // Filter by userId if specified, but always process all messages for pagination
            if (!userId || msg.author?.id === userId) {
                messages.push(msg);
                if (limit && messages.length >= limit) {
                    break;
                }
            }
        }

        // Report progress after processing batch
        if (onProgress) {
            onProgress(messages.length);
        }

        // Always update lastMessageId to the last message in the batch for pagination
        // This ensures we continue fetching even if the last message doesn't match the filter
        // CRITICAL: Use the last message's ID from the batch, not from filtered messages
        if (batch.length > 0) {
            lastMessageId = batch[batch.length - 1].id;
        }

        // If we got less than 100 messages, we've reached the end
        // But double-check by trying one more fetch to be sure
        if (batch.length < 100) {
            // Try one more fetch to ensure we didn't miss anything
            try {
                const verifyQuery: Record<string, string> = { limit: "100" };
                if (lastMessageId) {
                    verifyQuery.before = lastMessageId;
                }
                const verifyResponse = await RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    query: verifyQuery
                });
                const verifyBatch = verifyResponse.body as Message[];
                if (verifyBatch && verifyBatch.length > 0) {
                    // There are more messages, continue
                    continue;
                }
            } catch (error) {
                // If verification fails, assume we're done
                console.error("[PurgeMessages] Verification fetch failed:", error);
            }
            break;
        }
        
        // If we hit the limit, break
        if (limit && messages.length >= limit) {
            break;
        }

        // Small delay to avoid rate limiting during discovery
        await sleep(100);
    }
    
    // Clean up scan state
    activeScans.delete(channelId);

    return messages;
}

// Execute purge with rate limiting
async function executePurge(
    channelId: string,
    messages: Message[],
    canDeleteOthers: boolean
): Promise<{ deleted: number; failed: number }> {
    const purge = activePurges.get(channelId);
    if (!purge) {
        return { deleted: 0, failed: 0 };
    }

    let deleted = 0;
    let failed = 0;
    const currentUserId = UserStore.getCurrentUser().id;
    const deletionDelay = settings.store.deleteDelay || 200;

    for (const msg of messages) {
        // Check if purge was stopped
        if (purge.stop) {
            break;
        }

        // Check if we can delete this message
        const isOwnMessage = msg.author?.id === currentUserId;
        if (!isOwnMessage && !canDeleteOthers) {
            continue; // Skip messages we can't delete
        }

        try {
            await RestAPI.del({
                url: Constants.Endpoints.MESSAGE(channelId, msg.id)
            });
            deleted++;
            purge.deleted = deleted;

            // Rate limiting delay (skip after last message)
            if (messages.indexOf(msg) < messages.length - 1) {
                await sleep(deletionDelay);
            }
        } catch (error) {
            failed++;
            purge.failed = failed;
            console.error(`[PurgeMessages] Failed to delete message ${msg.id}:`, error);
            // Continue even if deletion fails
        }
    }

    return { deleted, failed };
}

export default definePlugin({
    name: "PurgeMessages",
    description: "Automate deleting messages with bulk delete functionality",
    authors: [{ name: "Aurick", id: 1348025017233047634n }],
    dependencies: ["CommandsAPI"],
    
    settings,

    commands: [
        {
            name: "vpurge",
            description: "Purge messages from a channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "self",
                    description: "Delete your own messages",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    options: [
                        {
                            name: "count",
                            description: "Number of messages to delete or 'all'",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        },
                        {
                            name: "after",
                            description: "Message ID to delete messages after (optional)",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        },
                        {
                            name: "before",
                            description: "Message ID to delete messages before (optional)",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        }
                    ]
                },
                {
                    name: "user",
                    description: "Delete messages from a user (requires manage messages permission)",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    options: [
                        {
                            name: "target",
                            description: "User whose messages to delete",
                            type: ApplicationCommandOptionType.USER,
                            required: true
                        },
                        {
                            name: "count",
                            description: "Number of messages to delete or 'all'",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        },
                        {
                            name: "after",
                            description: "Message ID to delete messages after (optional)",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        },
                        {
                            name: "before",
                            description: "Message ID to delete messages before (optional)",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        }
                    ]
                },
                {
                    name: "after",
                    description: "Delete messages after a specific message (optionally before another)",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    options: [
                        {
                            name: "message_id",
                            description: "Message ID to delete messages after",
                            type: ApplicationCommandOptionType.STRING,
                            required: true
                        },
                        {
                            name: "before",
                            description: "Message ID to delete messages before (optional, creates a range)",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        }
                    ]
                },
                {
                    name: "before",
                    description: "Delete messages before a specific message (optionally after another)",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    options: [
                        {
                            name: "message_id",
                            description: "Message ID to delete messages before",
                            type: ApplicationCommandOptionType.STRING,
                            required: true
                        },
                        {
                            name: "after",
                            description: "Message ID to delete messages after (optional, creates a range)",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
                        }
                    ]
                },
                {
                    name: "any",
                    description: "Delete any messages (last N messages from all users)",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    options: [
                        {
                            name: "count",
                            description: "Number of messages to delete",
                            type: ApplicationCommandOptionType.INTEGER,
                            required: true,
                            minValue: 1,
                            maxValue: 100
                        }
                    ]
                },
                {
                    name: "confirm",
                    description: "Confirm a pending 'all' purge operation",
                    type: ApplicationCommandOptionType.SUB_COMMAND
                }
            ],
            execute: async (opts, ctx) => {
                const channelId = ctx.channel.id;
                const currentUserId = UserStore.getCurrentUser().id;
                const subcommand = opts[0]?.name;
                
                // Helper to get option value from subcommand
                const getSubcommandOption = (name: string) => {
                    const subcmd = opts[0];
                    return subcmd?.options?.find((o: any) => o.name === name)?.value;
                };



                // Handle confirm command
                if (subcommand === "confirm") {
                    const confirmation = pendingConfirmations.get(channelId);
                    if (!confirmation) {
                        sendBotMessage(channelId, {
                            content: "No pending confirmation found. Use '/vpurge self all' or '/vpurge user [user] all' first."
                        });
                        return;
                    }

                    pendingConfirmations.delete(channelId);

                    // Check if purge already in progress
                    if (activePurges.has(channelId)) {
                        sendBotMessage(channelId, {
                            content: "A purge operation is already in progress in this channel. Use '/vpurge stop' to stop it first."
                        });
                        return;
                    }

                    // Start the purge
                    const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                    activePurges.set(channelId, purge);

                    sendBotMessage(channelId, {
                        content: `Starting purge of ${confirmation.count} message(s)...`
                    });

                    try {
                        const messages = await discoverMessages(channelId, {
                            userId: confirmation.userId,
                            limit: confirmation.count
                        });

                        if (messages.length === 0) {
                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: "No messages found to delete."
                            });
                            return;
                        }

                        const canDeleteOthers = canManageMessages(channelId);
                        const result = await executePurge(channelId, messages, canDeleteOthers);

                        activePurges.delete(channelId);
                        sendBotMessage(channelId, {
                            content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                        });
                    } catch (error) {
                        activePurges.delete(channelId);
                        console.error("[PurgeMessages] Error during purge:", error);
                        sendBotMessage(channelId, {
                            content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                        });
                    }
                    return;
                }

                // Check if purge already in progress
                if (activePurges.has(channelId)) {
                    sendBotMessage(channelId, {
                        content: "A purge operation is already in progress in this channel. Use '/vpurge stop' to stop it first."
                    });
                    return;
                }

                // Handle self command
                if (subcommand === "self") {
                    const countStr = getSubcommandOption("count") as string | undefined;
                    const afterId = getSubcommandOption("after") as string | undefined;
                    const beforeId = getSubcommandOption("before") as string | undefined;

                    // Check if using before/after options
                    if (afterId || beforeId) {
                        // Prohibit using count with before/after
                        if (countStr) {
                            sendBotMessage(channelId, {
                                content: "Cannot use 'count' together with 'before' or 'after' options. Use either count or before/after, not both."
                            });
                            return;
                        }

                        // Start purge
                        const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                        activePurges.set(channelId, purge);

                        const rangeText = afterId && beforeId
                            ? `between message ID ${afterId} and ${beforeId}`
                            : afterId
                            ? `after message ID ${afterId}`
                            : `before message ID ${beforeId}`;

                        try {
                            const messages = await discoverMessages(channelId, {
                                userId: currentUserId,
                                afterId: afterId,
                                beforeId: beforeId
                            });

                            if (messages.length === 0) {
                                activePurges.delete(channelId);
                                sendBotMessage(channelId, {
                                    content: `No messages found to delete ${rangeText}.`
                                });
                                return;
                            }

                            const result = await executePurge(channelId, messages, false);

                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                            });
                        } catch (error) {
                            activePurges.delete(channelId);
                            console.error("[PurgeMessages] Error during purge:", error);
                            sendBotMessage(channelId, {
                                content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                            });
                        }
                        return;
                    }

                    // Handle count-based purge
                    if (!countStr) {
                        sendBotMessage(channelId, {
                            content: "Please provide either a count ('all' or number) or use 'after'/'before' options."
                        });
                        return;
                    }

                    const isAll = countStr.toLowerCase() === "all";

                    if (isAll) {
                        // Start discovery with real-time updates
                        sendBotMessage(channelId, {
                            content: "Scanning messages... (0 found so far)"
                        });

                        // Track scan state so it can be stopped
                        activeScans.set(channelId, { stop: false });

                        // Track last update time to throttle updates
                        let lastUpdateTime = 0;
                        const updateInterval = 2000; // Update every 2 seconds max
                        
                        // Run discovery asynchronously so user can still type
                        discoverMessages(channelId, {
                            userId: currentUserId,
                            onProgress: (count) => {
                                // Update progress every 2 seconds or every 100 messages, whichever comes first
                                const now = Date.now();
                                if (count % 100 === 0 || count === 1 || (now - lastUpdateTime) >= updateInterval) {
                                    sendBotMessage(channelId, {
                                        content: `Scanning messages... (${count} found so far)`
                                    });
                                    lastUpdateTime = now;
                                }
                            }
                        }).then((messages) => {
                            if (messages.length === 0) {
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            pendingConfirmations.set(channelId, {
                                count: messages.length,
                                userId: currentUserId,
                                mode: "self"
                            });

                            sendBotMessage(channelId, {
                                content: `Scanning complete! Found ${messages.length} message(s). You are going to delete ${messages.length} number of messages. Confirm with "/vpurge confirm"`
                            });
                        }).catch((error) => {
                            activeScans.delete(channelId);
                            console.error("[PurgeMessages] Error discovering messages:", error);
                            sendBotMessage(channelId, {
                                content: `An error occurred while discovering messages: ${error instanceof Error ? error.message : String(error)}`
                            });
                        });
                    } else {
                        const count = parseInt(countStr, 10);
                        if (isNaN(count) || count < 1) {
                            sendBotMessage(channelId, {
                                content: "Invalid count. Please provide a number greater than 0 or 'all'."
                            });
                            return;
                        }

                        // Start purge immediately
                        const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                        activePurges.set(channelId, purge);

                        try {
                            const messages = await discoverMessages(channelId, {
                                userId: currentUserId,
                                limit: count
                            });

                            if (messages.length === 0) {
                                activePurges.delete(channelId);
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            const result = await executePurge(channelId, messages, false);

                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                            });
                        } catch (error) {
                            activePurges.delete(channelId);
                            console.error("[PurgeMessages] Error during purge:", error);
                            sendBotMessage(channelId, {
                                content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                            });
                        }
                    }
                    return;
                }

                // Handle user command
                if (subcommand === "user") {
                    // Check if in DM
                    if (isDM(channelId)) {
                        sendBotMessage(channelId, {
                            content: "This command can only be used in guild channels."
                        });
                        return;
                    }

                    // Check permissions
                    if (!canManageMessages(channelId)) {
                        sendBotMessage(channelId, {
                            content: "You need the 'Manage Messages' permission to use this command."
                        });
                        return;
                    }

                    const targetUser = getSubcommandOption("target") as any;
                    // USER option can be a string ID or an object with id property
                    let targetUserId: string;
                    if (typeof targetUser === "string") {
                        targetUserId = targetUser;
                    } else if (targetUser && targetUser.id) {
                        targetUserId = targetUser.id;
                    } else {
                        sendBotMessage(channelId, {
                            content: "Invalid user specified."
                        });
                        return;
                    }
                    const countStr = getSubcommandOption("count") as string | undefined;
                    const afterId = getSubcommandOption("after") as string | undefined;
                    const beforeId = getSubcommandOption("before") as string | undefined;

                    // Check if using before/after options
                    if (afterId || beforeId) {
                        // Prohibit using count with before/after
                        if (countStr) {
                            sendBotMessage(channelId, {
                                content: "Cannot use 'count' together with 'before' or 'after' options. Use either count or before/after, not both."
                            });
                            return;
                        }

                        // Start purge
                        const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                        activePurges.set(channelId, purge);

                        const rangeText = afterId && beforeId
                            ? `between message ID ${afterId} and ${beforeId}`
                            : afterId
                            ? `after message ID ${afterId}`
                            : `before message ID ${beforeId}`;

                        try {
                            const messages = await discoverMessages(channelId, {
                                userId: targetUserId,
                                afterId: afterId,
                                beforeId: beforeId
                            });

                            if (messages.length === 0) {
                                activePurges.delete(channelId);
                                sendBotMessage(channelId, {
                                    content: `No messages found to delete ${rangeText}.`
                                });
                                return;
                            }

                            const result = await executePurge(channelId, messages, true);

                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                            });
                        } catch (error) {
                            activePurges.delete(channelId);
                            console.error("[PurgeMessages] Error during purge:", error);
                            sendBotMessage(channelId, {
                                content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                            });
                        }
                        return;
                    }

                    // Handle count-based purge
                    if (!countStr) {
                        sendBotMessage(channelId, {
                            content: "Please provide either a count ('all' or number) or use 'after'/'before' options."
                        });
                        return;
                    }

                    const isAll = countStr.toLowerCase() === "all";

                    if (isAll) {
                        // Start discovery with real-time updates
                        sendBotMessage(channelId, {
                            content: "Scanning messages... (0 found so far)"
                        });

                        // Track scan state so it can be stopped
                        activeScans.set(channelId, { stop: false });

                        // Track last update time to throttle updates
                        let lastUpdateTime = 0;
                        const updateInterval = 2000; // Update every 2 seconds max
                        
                        // Run discovery asynchronously so user can still type
                        discoverMessages(channelId, {
                            userId: targetUserId,
                            onProgress: (count) => {
                                // Update progress every 2 seconds or every 100 messages, whichever comes first
                                const now = Date.now();
                                if (count % 100 === 0 || count === 1 || (now - lastUpdateTime) >= updateInterval) {
                                    sendBotMessage(channelId, {
                                        content: `Scanning messages... (${count} found so far)`
                                    });
                                    lastUpdateTime = now;
                                }
                            }
                        }).then((messages) => {
                            if (messages.length === 0) {
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            pendingConfirmations.set(channelId, {
                                count: messages.length,
                                userId: targetUserId,
                                mode: "user"
                            });

                            sendBotMessage(channelId, {
                                content: `Scanning complete! Found ${messages.length} message(s). You are going to delete ${messages.length} number of messages. Confirm with "/vpurge confirm"`
                            });
                        }).catch((error) => {
                            activeScans.delete(channelId);
                            console.error("[PurgeMessages] Error discovering messages:", error);
                            sendBotMessage(channelId, {
                                content: `An error occurred while discovering messages: ${error instanceof Error ? error.message : String(error)}`
                            });
                        });
                    } else {
                        const count = parseInt(countStr, 10);
                        if (isNaN(count) || count < 1) {
                            sendBotMessage(channelId, {
                                content: "Invalid count. Please provide a number greater than 0 or 'all'."
                            });
                            return;
                        }

                        // Start purge immediately
                        const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                        activePurges.set(channelId, purge);

                        try {
                            const messages = await discoverMessages(channelId, {
                                userId: targetUserId,
                                limit: count
                            });

                            if (messages.length === 0) {
                                activePurges.delete(channelId);
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            const result = await executePurge(channelId, messages, true);

                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                            });
                        } catch (error) {
                            activePurges.delete(channelId);
                            console.error("[PurgeMessages] Error during purge:", error);
                            sendBotMessage(channelId, {
                                content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                            });
                        }
                    }
                    return;
                }

                // Handle any command (purge any messages)
                if (subcommand === "any") {
                    // Check if in DM or lacks permission
                    const isDMChannel = isDM(channelId);
                    const hasPermission = canManageMessages(channelId);
                    const canDeleteOthers = !isDMChannel && hasPermission;

                    if (!canDeleteOthers) {
                        sendBotMessage(channelId, {
                            content: "This command requires 'Manage Messages' permission in guild channels, or can only delete your own messages in DMs."
                        });
                        return;
                    }

                    const count = getSubcommandOption("count") as number;
                    if (!count || count < 1) {
                        sendBotMessage(channelId, {
                            content: "Invalid count. Please provide a number greater than 0."
                        });
                        return;
                    }

                    // Start purge
                    const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                    activePurges.set(channelId, purge);

                    try {
                        const messages = await discoverMessages(channelId, {
                            limit: count
                        });

                        if (messages.length === 0) {
                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: "No messages found to delete."
                            });
                            return;
                        }

                        const result = await executePurge(channelId, messages, canDeleteOthers);

                        activePurges.delete(channelId);
                        sendBotMessage(channelId, {
                            content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                        });
                    } catch (error) {
                        activePurges.delete(channelId);
                        console.error("[PurgeMessages] Error during purge:", error);
                        sendBotMessage(channelId, {
                            content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                        });
                    }
                    return;
                }

                // Handle after command
                if (subcommand === "after") {
                    const messageId = getSubcommandOption("message_id") as string;
                    const beforeId = getSubcommandOption("before") as string | undefined;
                    
                    if (!messageId) {
                        sendBotMessage(channelId, {
                            content: "Invalid message ID specified."
                        });
                        return;
                    }

                    // Check if in DM or lacks permission
                    const isDMChannel = isDM(channelId);
                    const hasPermission = canManageMessages(channelId);
                    const canDeleteOthers = !isDMChannel && hasPermission;

                    // Start purge
                    const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                    activePurges.set(channelId, purge);

                    const rangeText = beforeId 
                        ? `between message ID ${messageId} and ${beforeId}`
                        : `after message ID ${messageId}`;

                    try {
                        const messages = await discoverMessages(channelId, {
                            afterId: messageId,
                            beforeId: beforeId,
                            userId: canDeleteOthers ? undefined : currentUserId
                        });

                        if (messages.length === 0) {
                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: `No messages found to delete ${rangeText}.`
                            });
                            return;
                        }

                        const result = await executePurge(channelId, messages, canDeleteOthers);

                        activePurges.delete(channelId);
                        sendBotMessage(channelId, {
                            content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                        });
                    } catch (error) {
                        activePurges.delete(channelId);
                        console.error("[PurgeMessages] Error during purge:", error);
                        sendBotMessage(channelId, {
                            content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                        });
                    }
                    return;
                }

                // Handle before command
                if (subcommand === "before") {
                    const messageId = getSubcommandOption("message_id") as string;
                    const afterId = getSubcommandOption("after") as string | undefined;
                    
                    if (!messageId) {
                        sendBotMessage(channelId, {
                            content: "Invalid message ID specified."
                        });
                        return;
                    }

                    // Check if in DM or lacks permission
                    const isDMChannel = isDM(channelId);
                    const hasPermission = canManageMessages(channelId);
                    const canDeleteOthers = !isDMChannel && hasPermission;

                    // Start purge
                    const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                    activePurges.set(channelId, purge);

                    // When using "before" command, afterId becomes the start and messageId becomes the end
                    const rangeText = afterId 
                        ? `between message ID ${afterId} and ${messageId}`
                        : `before message ID ${messageId}`;

                    try {
                        // For "before" command: messageId is the boundary, we want OLDER messages
                        // If afterId is provided, it's a range (afterId is newer, messageId is older)
                        const messages = await discoverMessages(channelId, {
                            afterId: afterId || undefined, // Only set if provided (for range)
                            beforeId: messageId, // messageId is always the beforeId boundary
                            userId: canDeleteOthers ? undefined : currentUserId
                        });

                        if (messages.length === 0) {
                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: `No messages found to delete ${rangeText}.`
                            });
                            return;
                        }

                        const result = await executePurge(channelId, messages, canDeleteOthers);

                        activePurges.delete(channelId);
                        sendBotMessage(channelId, {
                            content: `Successfully deleted ${result.deleted} message(s).${result.failed > 0 ? ` Failed to delete ${result.failed} message(s).` : ""}`
                        });
                    } catch (error) {
                        activePurges.delete(channelId);
                        console.error("[PurgeMessages] Error during purge:", error);
                        sendBotMessage(channelId, {
                            content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                        });
                    }
                    return;
                }
            }
        }
    ]
});

