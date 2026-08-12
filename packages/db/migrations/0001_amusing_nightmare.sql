ALTER TABLE "briefs" DROP CONSTRAINT "briefs_brief_date_unique";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "audience" text DEFAULT 'jason' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_emails" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "briefs" ADD COLUMN "audience" text DEFAULT 'jason' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "briefs_date_audience_key" ON "briefs" USING btree ("brief_date","audience");