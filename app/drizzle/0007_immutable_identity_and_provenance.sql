CREATE TYPE "public"."adoption_status" AS ENUM('pending', 'merged');--> statement-breakpoint
CREATE TYPE "public"."proposal_version_status" AS ENUM('pending', 'published');--> statement-breakpoint
ALTER TABLE "adoptions" ADD COLUMN "status" "adoption_status" DEFAULT 'merged' NOT NULL;--> statement-breakpoint
ALTER TABLE "adoptions" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "linked_github_user_id" text;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD COLUMN "status" "proposal_version_status" DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposal_versions" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "contributors_linked_github_user_id_idx" ON "contributors" USING btree ("linked_github_user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION proposal_versions_freeze() RETURNS trigger AS $$
DECLARE
  escape_hatch text := current_setting('agent_rooms.allow_provenance_mutation', true);
BEGIN
  IF escape_hatch = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'proposal_versions row % is published and cannot be deleted', OLD.version_id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.version_id IS DISTINCT FROM OLD.version_id
    OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.intent_summary IS DISTINCT FROM OLD.intent_summary
    OR NEW.diff_ref IS DISTINCT FROM OLD.diff_ref
    OR NEW.base_ref IS DISTINCT FROM OLD.base_ref
    OR NEW.base_sha IS DISTINCT FROM OLD.base_sha
    OR NEW.head_commit IS DISTINCT FROM OLD.head_commit
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
    OR NEW.pr_url IS DISTINCT FROM OLD.pr_url
    OR NEW.remix_note IS DISTINCT FROM OLD.remix_note
    OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'proposal_versions row % is published and its provenance columns are immutable', OLD.version_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS proposal_versions_freeze_trigger ON "proposal_versions";--> statement-breakpoint
CREATE TRIGGER proposal_versions_freeze_trigger
  BEFORE UPDATE OR DELETE ON "proposal_versions"
  FOR EACH ROW EXECUTE FUNCTION proposal_versions_freeze();
