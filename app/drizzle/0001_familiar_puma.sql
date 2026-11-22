CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"author_contributor_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_contributor_id_contributors_id_fk" FOREIGN KEY ("author_contributor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;