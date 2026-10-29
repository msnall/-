import { z } from "zod";

// Shared building blocks for the edit-plan schema and the effect catalog.
// This module (and everything under src/engine that does not end in .tsx)
// must stay free of React/Remotion imports so Node scripts can run it.

export const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Expected a hex color such as #c95f8e");

export const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and hyphens, e.g. \"main\" or \"s01\"");

// Every media reference is relative to public/, because Remotion can only
// serve files from there through staticFile().
export const publicPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/^[a-zA-Z]+:/.test(value) &&
      !value.split("/").some((part) => part === ".." || part === "." || part === ""),
    "Must be a path relative to public/ with forward slashes, e.g. \"recordings/Bloom10/clip.mp4\" (no leading /, no .., no drive letters or URLs)",
  );

export const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex SHA-256 digest");

export const px = z.number().finite();
export const size = z.number().finite().positive();
export const frames = z.number().int().nonnegative();
export const positiveFrames = z.number().int().positive();

export const box = z.strictObject({ x: px, y: px, width: size, height: size });

// A reference to an entry of plan.assets. The effect catalog lists which prop
// names hold asset ids so the plan validator can check them.
export const assetRef = id;

export type AssetType = "video" | "imageSequence" | "image" | "audio";
