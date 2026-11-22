ALTER TABLE "adoptions" ADD COLUMN "merge_commit_sha" text;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD COLUMN "pr_url" text;