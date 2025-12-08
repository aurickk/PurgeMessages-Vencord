# PurgeMessages Plugin

A Vencord plugin for automated message deletion with bulk delete functionality.

## Commands

### `/vpurge self [count] [after] [before]`
Delete your own messages.

- `count`: Number of messages or `"all"` (requires `/vpurge confirm`)
- `after`: Message ID to delete messages after
- `before`: Message ID to delete messages before
- Cannot use `count` with `after`/`before`

**Examples:**
```
/vpurge self 10
/vpurge self all
/vpurge self after:1234567890
/vpurge self before:1234567890
```

### `/vpurge user [target] [count] [after] [before]`
Delete messages from a user. Requires "Manage Messages" permission.

- `target`: User whose messages to delete
- `count`: Number of messages or `"all"` (requires `/vpurge confirm`)
- `after`: Message ID to delete messages after
- `before`: Message ID to delete messages before
- Cannot use `count` with `after`/`before`

**Examples:**
```
/vpurge user @User 10
/vpurge user @User all
/vpurge user @User after:1234567890
```

### `/vpurge after [message_id] [before]`
Delete messages after a message ID. Optionally specify `before` for a range.

- In guilds with permission: Deletes all messages
- In DMs or without permission: Only deletes your messages

**Examples:**
```
/vpurge after 1234567890
/vpurge after 1234567890 before:9876543210
```

### `/vpurge before [message_id] [after]`
Delete messages before a message ID. Optionally specify `after` for a range.

**Examples:**
```
/vpurge before 1234567890
/vpurge before 1234567890 after:9876543210
```

### `/vpurge any [count]`
Delete the last N messages from all users (1-100). Requires "Manage Messages" in guilds.

**Example:**
```
/vpurge any 50
```

### `/vpurge confirm`
Confirm a pending "all" purge operation.

## Settings

**Delete Delay**: Delay between deletions (default: 200ms). Adjust if you encounter rate limits.

Access: Vencord Settings → Plugins → PurgeMessages

## Notes

- "All" operations require confirmation via `/vpurge confirm`
- Use Developer Mode to easily copy message IDs
- Only one purge can run per channel at a time

