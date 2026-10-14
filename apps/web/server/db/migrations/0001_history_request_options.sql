ALTER TABLE `scrape_history` ADD `method` text DEFAULT 'GET' NOT NULL;--> statement-breakpoint
ALTER TABLE `scrape_history` ADD `headers` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `scrape_history` ADD `body` text;--> statement-breakpoint
ALTER TABLE `scrape_history` ADD `proxy` integer DEFAULT false NOT NULL;