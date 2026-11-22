ALTER TABLE "proposal_versions" RENAME COLUMN "base_commit" TO "base_ref";--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD COLUMN "base_sha" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "proposal_versions" ALTER COLUMN "base_sha" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "adoptions_proposal_id_idx" ON "adoptions" USING btree ("proposal_id");
