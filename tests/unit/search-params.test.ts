import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, gmailMessageUrl, pageHref, paginate, parseSearchParams, rpcArgs } from "@/lib/search/params";

const ID = "0f6b5a1e-1111-4222-8333-444455556666";

describe("search parameters", () => {
  it("accepts an empty search and blank fields", () => {
    expect(parseSearchParams({})).toEqual({ ok: true, params: { cursor: undefined } });
    expect(parseSearchParams({ q: "  ", customer: "", from: "", direction: "" })).toEqual({ ok: true, params: { cursor: undefined } });
  });

  it("parses every filter", () => {
    const r = parseSearchParams({ q: " Acme ", customer: ID, from: "2026-09-01", to: "2026-09-30", direction: "inbound", mailbox: "jeet@gocirkla.com" });
    expect(r).toEqual({
      ok: true,
      params: { q: "Acme", customer: ID, from: "2026-09-01", to: "2026-09-30", direction: "inbound", mailbox: "jeet@gocirkla.com", cursor: undefined },
    });
  });

  it.each([
    [{ q: "a" }, /at least 2/],
    [{ q: "x".repeat(101) }, /100 characters/],
    [{ customer: "'; drop table x;--" }, /Unknown customer/],
    [{ from: "2026-02-30" }, /real date/],
    [{ to: "yesterday" }, /real date/],
    [{ from: "2026-09-10", to: "2026-09-01" }, /after the to date/],
    [{ direction: "sideways" }, /direction/],
    [{ after: "not a cursor!" }, /no longer valid/],
    [{ after: Buffer.from("2026-09-01T00:00:00Z|not-a-uuid").toString("base64url") }, /no longer valid/],
  ])("rejects malformed input %#", (raw, msg) => {
    const r = parseSearchParams(raw as Record<string, string>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(msg);
  });

  it("uses only the first value when a parameter is repeated", () => {
    const r = parseSearchParams({ direction: ["outbound", "inbound"] });
    expect(r.ok && r.params.direction).toBe("outbound");
  });

  it("maps to the database call and asks for one extra row", () => {
    const r = parseSearchParams({ q: "acme", from: "2026-09-01" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(rpcArgs(r.params, 50)).toEqual({
        p_query: "acme", p_customer: null, p_from: "2026-09-01", p_to: null, p_direction: null, p_mailbox: null,
        p_cursor_at: null, p_cursor_id: null, p_limit: 51,
      });
    }
  });
});

describe("pagination", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ link_id: `0f6b5a1e-1111-4222-8333-44445555666${i}`, message_at: `2026-09-0${5 - i}T10:00:00+00:00` }));

  it("returns no next cursor when everything fits", () => {
    expect(paginate(rows.slice(0, 3), 3)).toEqual({ rows: rows.slice(0, 3) });
  });

  it("drops the extra row and points the cursor at the last shown row", () => {
    const p = paginate(rows, 3);
    expect(p.rows).toHaveLength(3);
    expect(decodeCursor(p.next!)).toEqual({ at: "2026-09-03T10:00:00.000Z", id: rows[2].link_id });
  });

  it("cursors round-trip and reject tampering", () => {
    const c = { at: "2026-09-01T00:00:00.000Z", id: ID };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(Buffer.from(`${c.at}|${ID}|extra`).toString("base64url"))).toBeUndefined();
    expect(decodeCursor(Buffer.from(`never|${ID}`).toString("base64url"))).toBeUndefined();
    expect(decodeCursor("../../etc")).toBeUndefined();
  });

  it("page links keep the filters and nothing else", () => {
    expect(pageHref({ q: "acme & co", direction: "inbound" }, "abc")).toBe("/search?q=acme+%26+co&direction=inbound&after=abc");
    expect(pageHref({})).toBe("/search");
  });
});

describe("Gmail links", () => {
  it("opens the message in the right account", () => {
    expect(gmailMessageUrl("18c2f0a1b2c3d4e5", "Jeet@GoCirkla.com")).toBe("https://mail.google.com/mail/?authuser=jeet%40gocirkla.com#all/18c2f0a1b2c3d4e5");
  });

  it("falls back to the default account when no mailbox is known", () => {
    expect(gmailMessageUrl("18c2f0a1b2c3d4e5")).toBe("https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3d4e5");
  });

  it.each(["", "abc/def", "javascript:alert(1)", "a#b", "x".repeat(65), "18c2 f0a1", "%2e%2e"])("refuses an id that is not a plain Gmail id: %j", (id) => {
    expect(gmailMessageUrl(id, "jeet@gocirkla.com")).toBeNull();
  });

  it("never lets a strange mailbox value change the link target", () => {
    const u = gmailMessageUrl("abc123", "x@y.com#evil");
    expect(u).toMatch(/^https:\/\/mail\.google\.com\/mail\//);
    expect(new URL(u!).host).toBe("mail.google.com");
  });
});

describe("Stage 3.2 guards", () => {
  const root = join(__dirname, "../..");
  const page = readFileSync(join(root, "app/(app)/search/page.tsx"), "utf8");
  const sql = readFileSync(join(root, "supabase/migrations/20261015000007_search.sql"), "utf8");

  it("the search page reads only through the access-checked database functions", () => {
    expect(page).not.toMatch(/\.from\(/);
    expect(page).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|createWorkerDb/);
    expect([...page.matchAll(/rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["admin_link_counts", "my_linked_customers", "search_my_links"]);
  });

  it("the search never passes a user id; the database uses auth.uid()", () => {
    expect(page).not.toMatch(/p_owner|p_user|user\.id/);
    expect(sql).toMatch(/where l\.owner_id = v_uid/);
    expect(sql).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
  });

  it("the migration adds no tables, columns, scopes or content storage", () => {
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/create table|alter table|add column|subject|body|snippet|gmail\.readonly|vector/i);
  });

  it("admin counts take no mailbox parameter", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.admin_link_counts"), sql.indexOf("returns table (customer_id uuid, customer_name text, link_count"));
    expect(fn).not.toMatch(/mailbox|owner/);
  });
});
