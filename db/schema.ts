import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const watchSessions = sqliteTable("watch_sessions", {
  token: text("token").primaryKey(),
  hostId: text("host_id").notNull(),
  sourceJson: text("source_json"),
  selectedMediaJson: text("selected_media_json"),
  playerJson: text("player_json").notNull(),
  seq: integer("seq").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const watchParticipants = sqliteTable(
  "watch_participants",
  {
    sessionToken: text("session_token").notNull(),
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    stateJson: text("state_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionToken, table.deviceId] })]
);


export const watchVoiceSignals = sqliteTable(
  "watch_voice_signals",
  {
    sessionToken: text("session_token").notNull(),
    id: text("id").notNull(),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    signalType: text("signal_type").notNull(),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionToken, table.id] }),
    index("watch_voice_signals_recipient_idx").on(
      table.sessionToken,
      table.toId,
      table.createdAt
    ),
  ]
);
