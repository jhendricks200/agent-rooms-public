CREATE TYPE "public"."agent_message_role" AS ENUM('system', 'user', 'assistant');--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" "agent_message_role" NOT NULL,
	"content" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_contributor_id" text NOT NULL,
	"room_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_owner_contributor_id_contributors_id_fk" FOREIGN KEY ("owner_contributor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_owner_room_idx" ON "agent_sessions" USING btree ("owner_contributor_id","room_id");