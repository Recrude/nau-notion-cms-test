import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// This schema is the contract between Notion and the site. A page that does not
// satisfy it fails the build instead of rendering half-empty. The sync script
// validates the same rules first so the error can name the Notion page.
const works = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/works" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      date: z.coerce.date(),
      category: z.enum(["Experience", "Commercial / Design", "The Nerdiest", "Beyond Canvas"]),
      summary: z.string().optional(),
      credits: z.array(z.string()).default([]),
      // image() gives the cover the optimised-asset type; a plain string would
      // ship the original bytes untouched.
      cover: image().optional(),
      video: z.string().url().optional(),
      order: z.number().optional(),
    }),
});

export const collections = { works };
