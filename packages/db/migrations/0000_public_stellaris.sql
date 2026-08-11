CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"encrypted_tokens" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_date" date NOT NULL,
	"markdown" text NOT NULL,
	"event_ids" uuid[] NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefs_brief_date_unique" UNIQUE("brief_date")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"external_id" text NOT NULL,
	"thread_id" text,
	"actor_name" text,
	"actor_handle" text,
	"subject" text,
	"body_excerpt" text,
	"url" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"is_from_owner" boolean DEFAULT false NOT NULL,
	"prefilter_verdict" text,
	"extracted" jsonb,
	"extracted_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"cursor" text,
	"subscription_id" text,
	"subscription_expires_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_delta_sync_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_external_id_key" ON "accounts" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_external_id_key" ON "events" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "events_occurred_idx" ON "events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_pending_extract_idx" ON "events" USING btree ("occurred_at") WHERE "events"."extracted" IS NULL AND "events"."prefilter_verdict" = 'keep';--> statement-breakpoint
CREATE INDEX "events_extracted_gin" ON "events" USING gin ("extracted");--> statement-breakpoint
CREATE INDEX "events_thread_idx" ON "events" USING btree ("thread_id","occurred_at");