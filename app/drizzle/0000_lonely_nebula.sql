CREATE TYPE "public"."proposal_state" AS ENUM('open', 'superseded', 'adopted', 'rejected');--> statement-breakpoint
CREATE TABLE "adoptions" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"proposal_version_id" text NOT NULL,
	"room_id" text NOT NULL,
	"adopted_by_contributor_id" text NOT NULL,
	"expected_head_commit" text NOT NULL,
	"merge_result" text NOT NULL,
	"adoption_receipt_ref" text NOT NULL,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributors" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"linked_discord_id" text,
	"linked_github_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forks" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"proposal_version_id" text NOT NULL,
	"by_contributor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_versions" (
	"version_id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"intent_summary" text NOT NULL,
	"diff_ref" text NOT NULL,
	"base_commit" text NOT NULL,
	"head_commit" text NOT NULL,
	"content_hash" text NOT NULL,
	"remix_note" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"author_contributor_id" text NOT NULL,
	"state" "proposal_state" DEFAULT 'open' NOT NULL,
	"parent_proposal_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_exchanges" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"question" text NOT NULL,
	"asked_by" text NOT NULL,
	"answer" text,
	"answered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"discord_channel_ref" text NOT NULL,
	"github_repo_ref" text NOT NULL,
	"maintainers" text[] NOT NULL,
	"adoption_authority" text DEFAULT 'maintainers' NOT NULL,
	"created_by" text NOT NULL,
	"license" text DEFAULT 'MIT' NOT NULL,
	"token_budget_per_user" integer,
	"token_budget_per_room" integer,
	"token_budget_used" integer DEFAULT 0 NOT NULL,
	"kill_switch_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adoptions" ADD CONSTRAINT "adoptions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adoptions" ADD CONSTRAINT "adoptions_proposal_version_id_proposal_versions_version_id_fk" FOREIGN KEY ("proposal_version_id") REFERENCES "public"."proposal_versions"("version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adoptions" ADD CONSTRAINT "adoptions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adoptions" ADD CONSTRAINT "adoptions_adopted_by_contributor_id_contributors_id_fk" FOREIGN KEY ("adopted_by_contributor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forks" ADD CONSTRAINT "forks_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forks" ADD CONSTRAINT "forks_proposal_version_id_proposal_versions_version_id_fk" FOREIGN KEY ("proposal_version_id") REFERENCES "public"."proposal_versions"("version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forks" ADD CONSTRAINT "forks_by_contributor_id_contributors_id_fk" FOREIGN KEY ("by_contributor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD CONSTRAINT "proposal_versions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_author_contributor_id_contributors_id_fk" FOREIGN KEY ("author_contributor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_exchanges" ADD CONSTRAINT "qa_exchanges_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_exchanges_id_idx" ON "qa_exchanges" USING btree ("id");