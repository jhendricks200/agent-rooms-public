CREATE TABLE "proposal_version_patches" (
	"version_id" text PRIMARY KEY NOT NULL,
	"base_sha" text NOT NULL,
	"patches" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_version_patches" ADD CONSTRAINT "proposal_version_patches_version_id_proposal_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."proposal_versions"("version_id") ON DELETE no action ON UPDATE no action;