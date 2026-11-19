CREATE TABLE "exchanges" (
	"id" integer PRIMARY KEY,
	"owner_id" text NOT NULL,
	"participants" jsonb DEFAULT '[]' NOT NULL,
	"pairings" jsonb DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
