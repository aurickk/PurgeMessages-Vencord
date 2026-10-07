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
    excludeIds?: Set<string>;
}

interface DiscoverOptions {
    userId?: string;
    afterId?: string;
    beforeId?: string;
    limit?: number;
    onProgress?: (count: number) => void;
}

const activePurges = new Map<string, ActivePurge>();
const pendingConfirmations = new Map<string, PendingConfirmation>();
const activeScans = new Map<string, { stop: boolean }>();

const BATCH_SIZE = 100;
const DISCOVERY_DELAY = 100;
const MAX_CONSECUTIVE_ERRORS = 3;
const PROGRESS_UPDATE_INTERVAL = 2000;

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseExcludeIds(excludeStr: string | undefined): Set<string> {
    if (!excludeStr) return new Set();
    return new Set(excludeStr.split(/[, ]+/).map(id => id.trim()).filter(id => id.length > 0));
}

function isDM(channelId: string): boolean {
    const channel = ChannelStore.getChannel(channelId);
    return channel ? (channel.type === 1 || channel.type === 3) : false;
}

function canManageMessages(channelId: string): boolean {
    if (isDM(channelId)) return false;
    const channel = ChannelStore.getChannel(channelId);
    return channel ? PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel) : false;
}

function shouldStop(channelId: string): boolean {
    return activeScans.get(channelId)?.stop || activePurges.get(channelId)?.stop || false;
}

async function fetchMessageBatch(channelId: string, before?: string, after?: string): Promise<Message[]> {
    const query: Record<string, string> = { limit: String(BATCH_SIZE) };
    if (before) query.before = before;
    if (after) query.after = after;

    const response = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query
    });

    return (response.body as Message[]) || [];
}

function getSnowflakeTimestamp(snowflake: string): number {
    const id = BigInt(snowflake);
    return Number((id >> 22n) + 1420070400000n);
}

async function discoverMessages(channelId: string, options: DiscoverOptions): Promise<Message[]> {
    const messages: Message[] = [];
    const { userId, afterId, beforeId, limit, onProgress } = options;
    let lastMessageId: string | undefined;

    if (shouldStop(channelId)) {
        activeScans.delete(channelId);
        return messages;
    }

    if (afterId || beforeId) {
        return discoverRangeMessages(channelId, { userId, afterId, beforeId });
    }

    let consecutiveErrors = 0;
    let lastSuccessfulBatchSize = 0;
    let lastReportedCount = 0;
    let emptyBatchCount = 0;
    const MAX_EMPTY_BATCHES = 3;
    const seenMessageIds = new Set<string>();

    while (true) {
        if (shouldStop(channelId)) {
            activeScans.delete(channelId);
            break;
        }

        if (limit && messages.length >= limit) break;

        let batch: Message[] = [];
        let success = false;

        for (let retry = 0; retry < 5; retry++) {
            try {
                batch = await fetchMessageBatch(channelId, lastMessageId);
                success = true;
                consecutiveErrors = 0;
                break;
            } catch (error) {
                console.error(`[PurgeMessages] Discovery error (attempt ${retry + 1}/5):`, error);
                
                const isRateLimit = error && typeof error === "object" && "status" in error && error.status === 429;
                const retryAfter = isRateLimit ? ((error as any).retry_after || 1000) : 0;
                const delay = isRateLimit 
                    ? Math.max(retryAfter * 1000, 2000 * (retry + 1))
                    : 1000 * Math.pow(2, retry);
                await sleep(delay);
            }
        }

        if (!success) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.error("[PurgeMessages] Too many consecutive errors, stopping discovery");
                break;
            }
            await sleep(1000);
            continue;
        }

        if (!batch || batch.length === 0) {
            emptyBatchCount++;
            
            if (emptyBatchCount >= MAX_EMPTY_BATCHES) {
                if (lastMessageId) {
                    for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
                        try {
                            const verifyBatch = await fetchMessageBatch(channelId, lastMessageId);
                            if (verifyBatch && verifyBatch.length > 0) {
                                emptyBatchCount = 0;
                                batch = verifyBatch;
                                break;
                            }
                        } catch (error) {
                            console.error(`[PurgeMessages] Verification attempt ${verifyAttempt + 1} failed:`, error);
                        }
                        await sleep(500 * (verifyAttempt + 1));
                    }
                }
                
                if (!batch || batch.length === 0) {
                    break;
                }
            } else {
                await sleep(300);
                continue;
            }
        } else {
            emptyBatchCount = 0;
        }

        lastSuccessfulBatchSize = batch.length;

        for (const msg of batch) {
            if (shouldStop(channelId)) {
                activeScans.delete(channelId);
                return messages;
            }

            if (seenMessageIds.has(msg.id)) {
                continue;
            }
            seenMessageIds.add(msg.id);

            if (!userId || msg.author?.id === userId) {
                messages.push(msg);
                if (limit && messages.length >= limit) break;
            }
        }

        if (onProgress && messages.length !== lastReportedCount) {
            onProgress(messages.length);
            lastReportedCount = messages.length;
        }

        if (batch.length > 0) {
            const newLastMessageId = batch[batch.length - 1].id;
            
            if (lastMessageId && newLastMessageId === lastMessageId) {
                break;
            }
            
            lastMessageId = newLastMessageId;
        }

        if (batch.length < BATCH_SIZE) {
            for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
                try {
                    const verifyBatch = await fetchMessageBatch(channelId, lastMessageId);
                    if (verifyBatch && verifyBatch.length > 0) {
                        batch = verifyBatch;
                        break;
                    }
                } catch (error) {
                    console.error(`[PurgeMessages] Verification attempt ${verifyAttempt + 1} failed:`, error);
                }
                await sleep(300 * (verifyAttempt + 1));
            }
            
            if (!batch || batch.length === 0) {
                break;
            }
        }

        if (limit && messages.length >= limit) break;
        await sleep(DISCOVERY_DELAY);
    }

    activeScans.delete(channelId);
    return messages;
}

async function discoverRangeMessages(
    channelId: string,
    options: { userId?: string; afterId?: string; beforeId?: string }
): Promise<Message[]> {
    const messages: Message[] = [];
    const { userId, afterId, beforeId } = options;
    let lastMessageId: string | undefined;
    let collecting = afterId && !beforeId;
    let foundBoundary = false;
    let emptyBatchCount = 0;
    const MAX_EMPTY_BATCHES = 3;
    const seenMessageIds = new Set<string>();

    while (true) {
        if (shouldStop(channelId)) {
            activeScans.delete(channelId);
            break;
        }

        let batch: Message[] = [];
        let success = false;

        for (let retry = 0; retry < 5; retry++) {
            try {
                batch = await fetchMessageBatch(channelId, lastMessageId);
                success = true;
                break;
            } catch (error) {
                console.error(`[PurgeMessages] Range discovery error (attempt ${retry + 1}/5):`, error);
                
                const isRateLimit = error && typeof error === "object" && "status" in error && error.status === 429;
                const retryAfter = isRateLimit ? ((error as any).retry_after || 1000) : 0;
                const delay = isRateLimit 
                    ? Math.max(retryAfter * 1000, 2000 * (retry + 1))
                    : 1000 * Math.pow(2, retry);
                await sleep(delay);
            }
        }

        if (!success) {
            break;
        }

        if (!batch || batch.length === 0) {
            emptyBatchCount++;
            
            if (emptyBatchCount >= MAX_EMPTY_BATCHES) {
                if (lastMessageId) {
                    for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
                        try {
                            const verifyBatch = await fetchMessageBatch(channelId, lastMessageId);
                            if (verifyBatch && verifyBatch.length > 0) {
                                emptyBatchCount = 0;
                                batch = verifyBatch;
                                break;
                            }
                        } catch (error) {
                            console.error(`[PurgeMessages] Range verification attempt ${verifyAttempt + 1} failed:`, error);
                        }
                        await sleep(500 * (verifyAttempt + 1));
                    }
                }
                
                if (!batch || batch.length === 0) {
                    break;
                }
            } else {
                await sleep(300);
                continue;
            }
        } else {
            emptyBatchCount = 0;
        }

        for (const msg of batch) {
            if (shouldStop(channelId)) break;

            if (seenMessageIds.has(msg.id)) {
                continue;
            }
            seenMessageIds.add(msg.id);

            if (afterId && !beforeId && msg.id === afterId) {
                foundBoundary = true;
                collecting = false;
                lastMessageId = msg.id;
                break;
            }

            if (beforeId && !afterId) {
                if (!foundBoundary) {
                    if (msg.id === beforeId) {
                        collecting = true;
                        foundBoundary = true;
                        lastMessageId = msg.id;
                        continue;
                    }
                    lastMessageId = msg.id;
                    continue;
                }
            }

            if (afterId && beforeId) {
                if (msg.id === beforeId) {
                    collecting = true;
                    foundBoundary = true;
                    lastMessageId = msg.id;
                    continue;
                }
                if (msg.id === afterId) {
                    collecting = false;
                    foundBoundary = true;
                    lastMessageId = msg.id;
                    break;
                }
            }

            if (collecting && (!userId || msg.author?.id === userId)) {
                messages.push(msg);
            }

            lastMessageId = msg.id;
        }

        if (afterId && foundBoundary && !collecting) break;
        if (afterId && beforeId && foundBoundary && !collecting) break;
        if (beforeId && !afterId && !foundBoundary && batch.length < BATCH_SIZE) break;
        
        if (batch.length < BATCH_SIZE) {
            for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
                try {
                    const verifyBatch = await fetchMessageBatch(channelId, lastMessageId);
                    if (verifyBatch && verifyBatch.length > 0) {
                        batch = verifyBatch;
                        break;
                    }
                } catch (error) {
                    console.error(`[PurgeMessages] Range verification attempt ${verifyAttempt + 1} failed:`, error);
                }
                await sleep(300 * (verifyAttempt + 1));
            }
            
            if (!batch || batch.length === 0) {
                break;
            }
        }

        await sleep(DISCOVERY_DELAY);
    }

    activeScans.delete(channelId);
    return messages;
}

async function executePurge(
    channelId: string,
    messages: Message[],
    canDeleteOthers: boolean,
    excludeIds?: Set<string>
): Promise<{ deleted: number; failed: number }> {
    const purge = activePurges.get(channelId);
    if (!purge) return { deleted: 0, failed: 0 };

    let deleted = 0;
    let failed = 0;
    const currentUserId = UserStore.getCurrentUser().id;
    const deletionDelay = settings.store.deleteDelay || 200;

    for (let i = 0; i < messages.length; i++) {
        if (purge.stop) break;

        const msg = messages[i];
        if (excludeIds?.has(msg.id)) continue;

        const isOwnMessage = msg.author?.id === currentUserId;
        if (!isOwnMessage && !canDeleteOthers) continue;

        try {
            await RestAPI.del({
                url: Constants.Endpoints.MESSAGE(channelId, msg.id)
            });
            deleted++;
            purge.deleted = deleted;

            if (i < messages.length - 1) {
                await sleep(deletionDelay);
            }
        } catch (error) {
            failed++;
            purge.failed = failed;
            console.error(`[PurgeMessages] Failed to delete message ${msg.id}:`, error);
        }
    }

    return { deleted, failed };
}

function formatResultMessage(deleted: number, failed: number): string {
    return `Successfully deleted ${deleted} message(s).${failed > 0 ? ` Failed to delete ${failed} message(s).` : ""}`;
}

function formatRangeText(afterId?: string, beforeId?: string): string {
    if (afterId && beforeId) return `between message ID ${afterId} and ${beforeId}`;
    if (afterId) return `after message ID ${afterId}`;
    return `before message ID ${beforeId}`;
}

async function runPurge(
    channelId: string,
    discoverOptions: DiscoverOptions,
    canDeleteOthers: boolean,
    excludeIds?: Set<string>,
    rangeText?: string
): Promise<void> {
    const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
    activePurges.set(channelId, purge);

    try {
        const messages = await discoverMessages(channelId, discoverOptions);

        if (messages.length === 0) {
            activePurges.delete(channelId);
            const text = rangeText || "to delete";
            sendBotMessage(channelId, {
                content: `No messages found ${text}.`
            });
            return;
        }

        const result = await executePurge(channelId, messages, canDeleteOthers, excludeIds);
        activePurges.delete(channelId);
        sendBotMessage(channelId, {
            content: formatResultMessage(result.deleted, result.failed)
        });
    } catch (error) {
        activePurges.delete(channelId);
        console.error("[PurgeMessages] Error during purge:", error);
        sendBotMessage(channelId, {
            content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
        });
    }
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
                        },
                        {
                            name: "exclude",
                            description: "Message ID(s) to exclude from deletion (comma-separated)",
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
                        },
                        {
                            name: "exclude",
                            description: "Message ID(s) to exclude from deletion (comma-separated)",
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
                        },
                        {
                            name: "exclude",
                            description: "Message ID(s) to exclude from deletion (comma-separated)",
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
                        },
                        {
                            name: "exclude",
                            description: "Message ID(s) to exclude from deletion (comma-separated)",
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
                        },
                        {
                            name: "exclude",
                            description: "Message ID(s) to exclude from deletion (comma-separated)",
                            type: ApplicationCommandOptionType.STRING,
                            required: false
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
                
                const getSubcommandOption = (name: string) => {
                    const subcmd = opts[0];
                    return subcmd?.options?.find((o: any) => o.name === name)?.value;
                };

                if (subcommand === "confirm") {
                    const confirmation = pendingConfirmations.get(channelId);
                    if (!confirmation) {
                        sendBotMessage(channelId, {
                            content: "No pending confirmation found. Use '/vpurge self all', '/vpurge user [user] all', or '/vpurge any all' first."
                        });
                        return;
                    }

                    pendingConfirmations.delete(channelId);

                    if (activePurges.has(channelId)) {
                        sendBotMessage(channelId, {
                            content: "A purge operation is already in progress in this channel. Use '/vpurge stop' to stop it first."
                        });
                        return;
                    }

                    const purge: ActivePurge = { stop: false, deleted: 0, failed: 0 };
                    activePurges.set(channelId, purge);

                    sendBotMessage(channelId, {
                        content: `Starting purge of ${confirmation.count} message(s)...`
                    });

                    (async () => {
                        try {
                            const messages = await discoverMessages(channelId, {
                                userId: confirmation.userId || undefined
                            });

                            const filteredMessages = confirmation.excludeIds?.size
                                ? messages.filter(msg => !confirmation.excludeIds!.has(msg.id))
                                : messages;

                            if (filteredMessages.length === 0) {
                                activePurges.delete(channelId);
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            const canDeleteOthers = canManageMessages(channelId);
                            const result = await executePurge(channelId, filteredMessages, canDeleteOthers, confirmation.excludeIds);

                            activePurges.delete(channelId);
                            sendBotMessage(channelId, {
                                content: formatResultMessage(result.deleted, result.failed)
                            });
                        } catch (error) {
                            activePurges.delete(channelId);
                            console.error("[PurgeMessages] Error during purge:", error);
                            sendBotMessage(channelId, {
                                content: `An error occurred during purge: ${error instanceof Error ? error.message : String(error)}`
                            });
                        }
                    })();
                    return;
                }

                if (activePurges.has(channelId)) {
                    sendBotMessage(channelId, {
                        content: "A purge operation is already in progress in this channel. Use '/vpurge stop' to stop it first."
                    });
                    return;
                }

                if (subcommand === "self") {
                    const countStr = getSubcommandOption("count") as string | undefined;
                    const afterId = getSubcommandOption("after") as string | undefined;
                    const beforeId = getSubcommandOption("before") as string | undefined;
                    const excludeStr = getSubcommandOption("exclude") as string | undefined;
                    const excludeIds = parseExcludeIds(excludeStr);

                    if (afterId || beforeId) {
                        if (countStr) {
                            sendBotMessage(channelId, {
                                content: "Cannot use 'count' together with 'before' or 'after' options. Use either count or before/after, not both."
                            });
                            return;
                        }

                        const rangeText = formatRangeText(afterId, beforeId);
                        runPurge(channelId, {
                            userId: currentUserId,
                            afterId,
                            beforeId
                        }, false, excludeIds, rangeText);
                        return;
                    }

                    if (!countStr) {
                        sendBotMessage(channelId, {
                            content: "Please provide either a count ('all' or number) or use 'after'/'before' options."
                        });
                        return;
                    }

                    const isAll = countStr.toLowerCase() === "all";

                    if (isAll) {
                        sendBotMessage(channelId, {
                            content: "Scanning messages... (0 found so far)"
                        });

                        activeScans.set(channelId, { stop: false });

                        let lastUpdateTime = 0;
                        
                        discoverMessages(channelId, {
                            userId: currentUserId,
                            onProgress: (count) => {
                                const now = Date.now();
                                if (count % 100 === 0 || count === 1 || (now - lastUpdateTime) >= PROGRESS_UPDATE_INTERVAL) {
                                    sendBotMessage(channelId, {
                                        content: `Scanning messages... (${count} found so far)`
                                    });
                                    lastUpdateTime = now;
                                }
                            }
                        }).then((messages) => {
                            const filteredMessages = messages.filter(msg => !excludeIds.has(msg.id));
                            
                            if (filteredMessages.length === 0) {
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            pendingConfirmations.set(channelId, {
                                count: filteredMessages.length,
                                userId: currentUserId,
                                mode: "self",
                                excludeIds
                            });

                            sendBotMessage(channelId, {
                                content: `Scanning complete! Found ${filteredMessages.length} message(s). You are going to delete ${filteredMessages.length} number of messages. Confirm with "/vpurge confirm"`
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

                        runPurge(channelId, {
                            userId: currentUserId,
                            limit: count
                        }, false, excludeIds);
                    }
                    return;
                }

                if (subcommand === "user") {
                    if (isDM(channelId)) {
                        sendBotMessage(channelId, {
                            content: "This command can only be used in guild channels."
                        });
                        return;
                    }

                    if (!canManageMessages(channelId)) {
                        sendBotMessage(channelId, {
                            content: "You need the 'Manage Messages' permission to use this command."
                        });
                        return;
                    }

                    const targetUser = getSubcommandOption("target") as any;
                    let targetUserId: string;
                    if (typeof targetUser === "string") {
                        targetUserId = targetUser;
                    } else if (targetUser?.id) {
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
                    const excludeStr = getSubcommandOption("exclude") as string | undefined;
                    const excludeIds = parseExcludeIds(excludeStr);

                    if (afterId || beforeId) {
                        if (countStr) {
                            sendBotMessage(channelId, {
                                content: "Cannot use 'count' together with 'before' or 'after' options. Use either count or before/after, not both."
                            });
                            return;
                        }

                        const rangeText = formatRangeText(afterId, beforeId);
                        runPurge(channelId, {
                            userId: targetUserId,
                            afterId,
                            beforeId
                        }, true, excludeIds, rangeText);
                        return;
                    }

                    if (!countStr) {
                        sendBotMessage(channelId, {
                            content: "Please provide either a count ('all' or number) or use 'after'/'before' options."
                        });
                        return;
                    }

                    const isAll = countStr.toLowerCase() === "all";

                    if (isAll) {
                        sendBotMessage(channelId, {
                            content: "Scanning messages... (0 found so far)"
                        });

                        activeScans.set(channelId, { stop: false });

                        let lastUpdateTime = 0;
                        
                        discoverMessages(channelId, {
                            userId: targetUserId,
                            onProgress: (count) => {
                                const now = Date.now();
                                if (count % 100 === 0 || count === 1 || (now - lastUpdateTime) >= PROGRESS_UPDATE_INTERVAL) {
                                    sendBotMessage(channelId, {
                                        content: `Scanning messages... (${count} found so far)`
                                    });
                                    lastUpdateTime = now;
                                }
                            }
                        }).then((messages) => {
                            const filteredMessages = messages.filter(msg => !excludeIds.has(msg.id));
                            
                            if (filteredMessages.length === 0) {
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            pendingConfirmations.set(channelId, {
                                count: filteredMessages.length,
                                userId: targetUserId,
                                mode: "user",
                                excludeIds
                            });

                            sendBotMessage(channelId, {
                                content: `Scanning complete! Found ${filteredMessages.length} message(s). You are going to delete ${filteredMessages.length} number of messages. Confirm with "/vpurge confirm"`
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

                        runPurge(channelId, {
                            userId: targetUserId,
                            limit: count
                        }, true, excludeIds);
                    }
                    return;
                }

                if (subcommand === "any") {
                    const isDMChannel = isDM(channelId);
                    const hasPermission = canManageMessages(channelId);
                    const canDeleteOthers = !isDMChannel && hasPermission;

                    if (!canDeleteOthers) {
                        sendBotMessage(channelId, {
                            content: "This command requires 'Manage Messages' permission in guild channels, or can only delete your own messages in DMs."
                        });
                        return;
                    }

                    const countStr = getSubcommandOption("count") as string | undefined;
                    const afterId = getSubcommandOption("after") as string | undefined;
                    const beforeId = getSubcommandOption("before") as string | undefined;
                    const excludeStr = getSubcommandOption("exclude") as string | undefined;
                    const excludeIds = parseExcludeIds(excludeStr);

                    if (afterId || beforeId) {
                        if (countStr) {
                            sendBotMessage(channelId, {
                                content: "Cannot use 'count' together with 'before' or 'after' options. Use either count or before/after, not both."
                            });
                            return;
                        }

                        const rangeText = formatRangeText(afterId, beforeId);
                        runPurge(channelId, {
                            afterId,
                            beforeId
                        }, canDeleteOthers, excludeIds, rangeText);
                        return;
                    }

                    if (!countStr) {
                        sendBotMessage(channelId, {
                            content: "Please provide either a count ('all' or number) or use 'after'/'before' options."
                        });
                        return;
                    }

                    const isAll = countStr.toLowerCase() === "all";

                    if (isAll) {
                        sendBotMessage(channelId, {
                            content: "Scanning messages... (0 found so far)"
                        });

                        activeScans.set(channelId, { stop: false });

                        let lastUpdateTime = 0;
                        
                        discoverMessages(channelId, {
                            onProgress: (count) => {
                                const now = Date.now();
                                if (count % 100 === 0 || count === 1 || (now - lastUpdateTime) >= PROGRESS_UPDATE_INTERVAL) {
                                    sendBotMessage(channelId, {
                                        content: `Scanning messages... (${count} found so far)`
                                    });
                                    lastUpdateTime = now;
                                }
                            }
                        }).then((messages) => {
                            const filteredMessages = messages.filter(msg => !excludeIds.has(msg.id));
                            
                            if (filteredMessages.length === 0) {
                                sendBotMessage(channelId, {
                                    content: "No messages found to delete."
                                });
                                return;
                            }

                            pendingConfirmations.set(channelId, {
                                count: filteredMessages.length,
                                userId: undefined,
                                mode: "self",
                                excludeIds
                            });

                            sendBotMessage(channelId, {
                                content: `Scanning complete! Found ${filteredMessages.length} message(s). You are going to delete ${filteredMessages.length} number of messages. Confirm with "/vpurge confirm"`
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

                        runPurge(channelId, {
                            limit: count
                        }, canDeleteOthers, excludeIds);
                    }
                    return;
                }

                if (subcommand === "after") {
                    const messageId = getSubcommandOption("message_id") as string;
                    const beforeId = getSubcommandOption("before") as string | undefined;
                    const excludeStr = getSubcommandOption("exclude") as string | undefined;
                    const excludeIds = parseExcludeIds(excludeStr);
                    
                    if (!messageId) {
                        sendBotMessage(channelId, {
                            content: "Invalid message ID specified."
                        });
                        return;
                    }

                    const isDMChannel = isDM(channelId);
                    const hasPermission = canManageMessages(channelId);
                    const canDeleteOthers = !isDMChannel && hasPermission;

                    const rangeText = formatRangeText(messageId, beforeId);
                    runPurge(channelId, {
                        afterId: messageId,
                        beforeId,
                        userId: canDeleteOthers ? undefined : currentUserId
                    }, canDeleteOthers, excludeIds, rangeText);
                    return;
                }

                if (subcommand === "before") {
                    const messageId = getSubcommandOption("message_id") as string;
                    const afterId = getSubcommandOption("after") as string | undefined;
                    const excludeStr = getSubcommandOption("exclude") as string | undefined;
                    const excludeIds = parseExcludeIds(excludeStr);
                    
                    if (!messageId) {
                        sendBotMessage(channelId, {
                            content: "Invalid message ID specified."
                        });
                        return;
                    }

                    const isDMChannel = isDM(channelId);
                    const hasPermission = canManageMessages(channelId);
                    const canDeleteOthers = !isDMChannel && hasPermission;

                    const rangeText = formatRangeText(afterId, messageId);
                    runPurge(channelId, {
                        afterId: afterId || undefined,
                        beforeId: messageId,
                        userId: canDeleteOthers ? undefined : currentUserId
                    }, canDeleteOthers, excludeIds, rangeText);
                    return;
                }
            }
        }
    ]
});
