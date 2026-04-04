#!/usr/bin/env node
/**
 * Track housing application status.
 *
 * Usage:
 *   node track.js                          # Show all tracked listings
 *   node track.js apply <url> [address]    # Mark as applied
 *   node track.js shortlist <url> [address]# Add to shortlist
 *   node track.js exclude <url> <reason>   # Exclude (not interested)
 *   node track.js reject <url>             # They rejected you
 *   node track.js note <url> <text>        # Add a note
 *   node track.js check <url>              # Check if already tracked
 *   node track.js backfill                 # Populate price/address from cache
 *   node track.js status                   # Dashboard with stats
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  TRACKER_FILE,
  LISTINGS_DIR,
  loadCachedListing,
  cacheKeyFromUrl,
} from "./lib.js";

function load() {
  if (fs.existsSync(TRACKER_FILE))
    return JSON.parse(fs.readFileSync(TRACKER_FILE, "utf8"));
  return {
    applied: [],
    shortlisted: [],
    rejected: [],
    excluded: [],
    notes: {},
  };
}

function save(data) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
}

function extractId(url) {
  return (
    url.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
    )?.[1] || url
  );
}

function findInAll(data, url) {
  const id = extractId(url);
  for (const cat of ["applied", "shortlisted", "rejected", "excluded"]) {
    const found = (data[cat] || []).find((e) => extractId(e.url) === id);
    if (found) return { category: cat, entry: found };
  }
  return null;
}

function formatDate() {
  return new Date().toISOString().split("T")[0];
}

/**
 * Look up cached listing detail and return { price, address } if available.
 */
function lookupFromCache(url) {
  const cached = loadCachedListing(url);
  if (!cached) return { price: null, address: null };

  const price = cached.rent || null;
  let address = cached.address || null;
  if (address && cached.city) {
    if (!address.includes(cached.city)) {
      address = `${address}, ${cached.city}`;
    }
  }
  return { price, address };
}

/**
 * Silent backfill: populate missing price/address from cached listings.
 * Returns number of entries updated.
 */
function runBackfill(data, silent = false) {
  let updated = 0;
  for (const cat of ["applied", "shortlisted", "rejected", "excluded"]) {
    for (const entry of data[cat] || []) {
      if (entry.price && entry.address) continue;
      const { price, address } = lookupFromCache(entry.url);
      let changed = false;
      if (!entry.price && price) {
        entry.price = price;
        changed = true;
      }
      if (!entry.address && address) {
        entry.address = address;
        changed = true;
      }
      if (changed) {
        updated++;
        if (!silent) {
          console.log(
            `  Updated: CHF ${entry.price || "?"} | ${entry.address || "?"} | ${entry.url.substring(0, 60)}...`,
          );
        }
      }
    }
  }
  if (updated > 0) {
    save(data);
  }
  return updated;
}

const data = load();

// Auto-backfill on every command (silent)
runBackfill(data, true);

const [, , cmd, ...cmdArgs] = process.argv;

switch (cmd) {
  case undefined:
  case "list": {
    for (const cat of ["shortlisted", "applied", "rejected", "excluded"]) {
      if (!data[cat] || data[cat].length === 0) continue;
      console.log(`\n  ${cat.toUpperCase()} (${data[cat].length}):`);
      for (const e of data[cat]) {
        const note = data.notes[extractId(e.url)];
        console.log(
          `    CHF ${e.price || "?"} | ${e.address || "?"} | ${e.date || ""}`,
        );
        if (e.reason) console.log(`      Reason: ${e.reason}`);
        if (note) console.log(`      Note: ${note}`);
        console.log(`      ${e.url}`);
      }
    }
    const total =
      (data.applied?.length || 0) +
      (data.shortlisted?.length || 0) +
      (data.rejected?.length || 0) +
      (data.excluded?.length || 0);
    if (total === 0) console.log("  No tracked listings yet.");
    console.log();
    break;
  }

  case "apply": {
    const [url, ...rest] = cmdArgs;
    if (!url) {
      console.log("Usage: node track.js apply <url> [address]");
      break;
    }
    const existing = findInAll(data, url);
    if (existing) {
      console.log(
        `  Already tracked as ${existing.category}: ${existing.entry.address || existing.entry.url}`,
      );
      break;
    }
    const { price, address: cachedAddr } = lookupFromCache(url);
    const manualAddr = rest.join(" ") || null;
    const finalAddr = manualAddr || cachedAddr;
    data.applied.push({
      url,
      address: finalAddr,
      price: price,
      date: formatDate(),
    });
    save(data);
    const info = [];
    if (price) info.push(`CHF ${price}`);
    if (finalAddr) info.push(finalAddr);
    console.log(
      `  Marked as applied.${info.length ? " (" + info.join(", ") + ")" : ""}`,
    );
    break;
  }

  case "shortlist": {
    const [url, ...rest] = cmdArgs;
    if (!url) {
      console.log("Usage: node track.js shortlist <url> [address]");
      break;
    }
    const { price, address: cachedAddr } = lookupFromCache(url);
    const manualAddr = rest.join(" ") || null;
    data.shortlisted.push({
      url,
      address: manualAddr || cachedAddr,
      price: price,
      date: formatDate(),
    });
    save(data);
    console.log("  Added to shortlist.");
    break;
  }

  case "exclude": {
    const [url, ...rest] = cmdArgs;
    if (!url) {
      console.log("Usage: node track.js exclude <url> <reason>");
      break;
    }
    const { price, address: cachedAddr } = lookupFromCache(url);
    data.excluded.push({
      url,
      address: cachedAddr,
      price: price,
      reason: rest.join(" ") || null,
      date: formatDate(),
    });
    save(data);
    console.log("  Excluded.");
    break;
  }

  case "reject": {
    const [url] = cmdArgs;
    if (!url) {
      console.log("Usage: node track.js reject <url>");
      break;
    }
    const idx = data.applied.findIndex(
      (e) => extractId(e.url) === extractId(url),
    );
    if (idx > -1) {
      const entry = data.applied.splice(idx, 1)[0];
      entry.rejectedDate = formatDate();
      data.rejected.push(entry);
    } else {
      const { price, address } = lookupFromCache(url);
      data.rejected.push({ url, price, address, date: formatDate() });
    }
    save(data);
    console.log("  Marked as rejected.");
    break;
  }

  case "note": {
    const [url, ...rest] = cmdArgs;
    if (!url || !rest.length) {
      console.log("Usage: node track.js note <url> <text>");
      break;
    }
    data.notes[extractId(url)] = rest.join(" ");
    save(data);
    console.log("  Note saved.");
    break;
  }

  case "check": {
    const [url] = cmdArgs;
    if (!url) {
      console.log("Usage: node track.js check <url>");
      break;
    }
    const found = findInAll(data, url);
    if (found) {
      console.log(`  Status: ${found.category}`);
      if (found.entry.address) console.log(`  Address: ${found.entry.address}`);
      if (found.entry.price) console.log(`  Price: CHF ${found.entry.price}`);
      if (found.entry.reason) console.log(`  Reason: ${found.entry.reason}`);
      const note = data.notes[extractId(url)];
      if (note) console.log(`  Note: ${note}`);
    } else {
      console.log("  Not tracked.");
    }
    break;
  }

  case "backfill": {
    const count = runBackfill(data, false);
    if (count > 0) {
      console.log(`\n  Backfilled ${count} entries.`);
    } else {
      console.log(
        "  Nothing to backfill (all entries already populated or no cache data).",
      );
    }
    break;
  }

  case "status": {
    const appliedCount = data.applied?.length || 0;
    const excludedCount = data.excluded?.length || 0;
    const rejectedCount = data.rejected?.length || 0;
    const shortlistedCount = data.shortlisted?.length || 0;
    const totalCount =
      appliedCount + excludedCount + rejectedCount + shortlistedCount;

    console.log("\n  ── Housing Search Dashboard ──────────────────────────");
    console.log(`\n  Total tracked: ${totalCount}`);
    console.log(
      `  Applied: ${appliedCount} | Shortlisted: ${shortlistedCount} | Rejected: ${rejectedCount} | Excluded: ${excludedCount}`,
    );

    // Applied listings detail
    if (appliedCount > 0) {
      console.log("\n  ── Applied ──────────────────────────────────────────");
      const today = new Date();
      const appliedPrices = [];

      for (const e of data.applied) {
        const daysSince = e.date
          ? Math.round((today - new Date(e.date)) / (1000 * 60 * 60 * 24))
          : "?";
        const price = e.price ? `CHF ${e.price}` : "price ?";
        const addr = e.address || "address ?";
        console.log(
          `    ${price} | ${addr} | applied ${e.date || "?"} (${daysSince}d ago)`,
        );
        const note = data.notes[extractId(e.url)];
        if (note) console.log(`      Note: ${note}`);
        if (e.price) appliedPrices.push(e.price);
      }

      // Summary stats
      if (appliedPrices.length > 0) {
        const avg = Math.round(
          appliedPrices.reduce((a, b) => a + b, 0) / appliedPrices.length,
        );
        const min = Math.min(...appliedPrices);
        const max = Math.max(...appliedPrices);
        console.log(
          `\n  Applied price stats: avg CHF ${avg} | min CHF ${min} | max CHF ${max}`,
        );
      }
    }

    // Shortlisted
    if (shortlistedCount > 0) {
      console.log("\n  ── Shortlisted ──────────────────────────────────────");
      for (const e of data.shortlisted) {
        const price = e.price ? `CHF ${e.price}` : "price ?";
        console.log(`    ${price} | ${e.address || "?"} | ${e.date || "?"}`);
      }
    }

    // Rejected
    if (rejectedCount > 0) {
      console.log(`\n  ── Rejected (${rejectedCount}) ──────────────────────`);
      for (const e of data.rejected) {
        const price = e.price ? `CHF ${e.price}` : "price ?";
        console.log(`    ${price} | ${e.address || "?"} | ${e.date || "?"}`);
      }
    }

    // Excluded breakdown
    if (excludedCount > 0) {
      const reasons = {};
      for (const e of data.excluded) {
        const r = e.reason || "no reason";
        const bucket = r.startsWith("Auto-excluded:")
          ? r
          : r.includes("WOKO")
            ? "WOKO/JUWO"
            : r.includes("JUWO")
              ? "WOKO/JUWO"
              : "Manual";
        reasons[bucket] = (reasons[bucket] || 0) + 1;
      }
      console.log(
        `\n  ── Excluded breakdown (${excludedCount}) ──────────────`,
      );
      for (const [reason, count] of Object.entries(reasons).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`    ${count}x ${reason}`);
      }
    }

    console.log();
    break;
  }

  default:
    console.log("Unknown command:", cmd);
    console.log(
      "Commands: list, apply, shortlist, exclude, reject, note, check, backfill, status",
    );
}
