/**
 * Name generator for subdermial agents.
 *
 * Uses a pre-generated pool of 80 adjective-noun pairs.
 * Names are drawn without replacement within a session.
 * The pool can be regenerated at any time via the regenerateNames() function.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_POOL_SIZE = 80;

let namePool: string[] = [];
let poolPath: string = "";

/**
 * Load the name pool from the JSON file.
 */
export function loadNamePool(poolFilePath: string): void {
  poolPath = poolFilePath;
  try {
    const raw = fs.readFileSync(poolFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
      namePool = parsed;
    }
  } catch {
    // Fallback: use a small built-in pool
    namePool = [
      "pensive-whale", "wiry-bismuth", "muddy-dove", "quiet-bear", "flashy-fox",
      "eager-falcon", "rusty-lynx", "nimble-otter", "swift-raven", "cosmic-cobra",
    ];
  }
}

/**
 * Pick an unused name from the pool.
 * Tracks used names to avoid duplicates within a session.
 * Returns null if the pool is exhausted.
 */
export function pickName(usedNames: Set<string>): string | null {
  // Shuffle available names and pick first unused
  const available = namePool.filter((n) => !usedNames.has(n));
  if (available.length === 0) {
    // If pool exhausted, generate a fallback with timestamp
    return `agent-${Date.now().toString(36)}`;
  }
  // Pick randomly for variety
  const idx = Math.floor(Math.random() * available.length);
  return available[idx];
}

/**
 * Regenerate the name pool by combining adjectives and nouns.
 * Writes back to the pool file.
 */
export function regenerateNamePool(customPoolPath?: string): string[] {
  const adjectives = [
    "pensive", "wiry", "muddy", "quiet", "flashy", "eager", "rusty", "nimble", "swift",
    "cosmic", "quantum", "silent", "witty", "fuzzy", "cryptic", "jolly", "sleepy", "brisk",
    "moody", "clever", "frantic", "glossy", "brazen", "subtle", "vivid", "chilly", "fierce",
    "gentle", "humble", "lucid", "merry", "noble", "ornate", "plucky", "quirky", "rowdy",
    "slick", "tidy", "upbeat", "wacky", "zesty", "calm", "deft", "keen", "lanky", "mellow",
    "perky", "snappy", "sunny", "breezy", "dapper", "fizzy", "jaunty", "lucky", "plush",
    "rosy", "spry", "tawny", "zany", "amber", "brash", "canny", "dreamy", "earthy",
    "frosty", "giddy", "hazy", "icy", "jazzy", "knotty", "lithe", "misty", "nifty",
    "opaque", "regal", "sage", "timid", "umber",
  ];

  const nouns = [
    "whale", "bismuth", "dove", "bear", "fox", "falcon", "lynx", "otter", "raven", "cobra",
    "panda", "tiger", "shark", "hawk", "wolf", "viper", "gecko", "ibis", "crane", "heron",
    "quokka", "wombat", "badger", "beaver", "ferret", "marlin", "stoat", "tapir", "okapi",
    "dingo", "impala", "caribou", "serval", "walrus", "narwhal", "manatee", "barracuda",
    "puffin", "axolotl", "platypus", "capybara", "armadillo", "ermine", "gazelle", "jackal",
    "kudu", "llama", "meerkat", "ocelot", "pangolin", "quoll", "raccoon", "salamander",
    "tamarin", "urial", "vicuña", "wallaby", "xerus", "yak", "zebu", "albatross", "bobcat",
    "condor", "dugong", "echidna", "fennec", "gibbon", "harrier", "iguana", "jaguar",
    "kiwi", "lemur", "magpie", "newt", "octopus", "pelican", "quetzal", "saola", "toucan",
    "uakari",
  ];

  const pool: string[] = [];
  const used = new Set<string>();

  while (pool.length < DEFAULT_POOL_SIZE) {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const name = `${adj}-${noun}`;
    if (!used.has(name)) {
      used.add(name);
      pool.push(name);
    }
  }

  const targetPath = customPoolPath || poolPath;
  if (targetPath) {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(pool, null, 2), "utf-8");
    } catch {
      // Non-fatal: just use in-memory pool
    }
  }

  namePool = pool;
  return pool;
}
