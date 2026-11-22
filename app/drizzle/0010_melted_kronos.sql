CREATE TABLE "rate_limit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"contributor_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_events_lookup_idx" ON "rate_limit_events" USING btree ("contributor_id","action","created_at");