---
name: topic-digest
description: When you want to catch up on Hacker News but only care about a specific subject, and need a quick summary.
---

# Topic digest

Part of hn-digest. When you want to catch up on Hacker News but only care about a specific subject, and need a quick summary.

## When to use this

When you want to catch up on Hacker News but only care about a specific subject, and need a quick summary.

## What this needs

- topic (text, required)

## What a good result looks like

A markdown document listing the matching stories, where each item clearly displays its real title, link, points, and exactly one plain sentence explaining why it matters.

## What it produces

- digest (text/markdown, per task)

## When it comes back empty

If no top stories match the requested topic, it returns a plain document stating that no matches were found in the current top list, without inventing any news.

## How to do it

The script fetches top stories from the Hacker News API and triggers the text-reasoning model to filter them by the requested topic and write the summary sentences. Exact limits, constraints, schemas, and formatting rules are loaded directly from spec.json, ensuring the digest is built correctly without hallucinating details.

## Scripts

Run these from this skill's folder; each one says what it needs at the top.

- scripts/topic-digest.mjs
