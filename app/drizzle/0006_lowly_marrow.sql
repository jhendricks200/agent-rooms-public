CREATE TYPE "public"."agent_reservation_status" AS ENUM('pending', 'committed', 'released');--> statement-breakpoint
CREATE TABLE "agent_usage_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"room_id" text NOT NULL,
	"contributor_id" text NOT NULL,
	"estimated_tokens" integer NOT NULL,
	"actual_tokens" integer,
	"status" "agent_reservation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "served_provider" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "off_policy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_usage_reservations" ADD CONSTRAINT "agent_usage_reservations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_reservations" ADD CONSTRAINT "agent_usage_reservations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_reservations" ADD CONSTRAINT "agent_usage_reservations_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;