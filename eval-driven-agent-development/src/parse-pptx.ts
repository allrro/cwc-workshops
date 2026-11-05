// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure .pptx parsing — no model calls, no scoring policy.
 * Walks the zip, parses each slide's XML, returns per-slide structural
 * facts (shape/picture counts, text runs, font sizes, title/body split).
 * Everything a code-check needs to compute a metric lives on ParsedPptx.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import * as fs from "node:fs/promises";
import { posix as path } from "node:path";

/**
 * Structural counts for one slide, pulled directly from the OOXML — what the
 * code-based graders read. No model calls.
 */
export interface SlideMetrics {
    /** 1-based slide number. */
    index: number;
    /** Top-level shapes of any kind (sp, pic, graphicFrame, grpSp, cxnSp). */
    shapeCount: number;
    /** Embedded raster images (`<p:pic>`) — what `img%` counts. */
    pictureCount: number;
    /** Total characters across all text runs (titles + headers + body). */
    textChars: number;
    /** Distinct font sizes (pt) used on the slide, ascending. */
    fontSizesPt: number[];
    /** Unicode emoji codepoints in the text. */
    emojiCount: number;
}

/**
 * One slide's title and body text, separated by the placeholder/largest-font
 * heuristic. Feeds the coherence judge.
 */
export interface SlideTexts {
    index: number;
    title: string;
    body: string;
}

/**
 * Result of {@link parsePptx}: file-level validity plus per-slide metrics and
 * extracted texts. validPresentation distinguishes an actual nonempty slide
 * deck from a readable ZIP with missing or invalid presentation parts.
 */
export interface ParsedPptx {
    exists: boolean;
    validZip: boolean;
    validPresentation: boolean;
    slideCount: number;
    perSlide: SlideMetrics[];
    slideTexts: SlideTexts[];
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

const EMPTY = (exists: boolean, validZip: boolean): ParsedPptx => ({
    exists,
    validZip,
    validPresentation: false,
    slideCount: 0,
    perSlide: [],
    slideTexts: [],
});

// Follow the package and presentation relationships. An orphan slide-like ZIP
// entry is not a slide in the deck; presentation order comes from sldIdLst.
// Namespace prefixes are aliases (e.g. p:sld and ppt:sld).
const localName = (name: string) => name.split(":").pop()!;
const packageParser = new XMLParser({
    ignoreAttributes: false,
    transformTagName: localName,
    isArray: name => ["Relationship", "Override", "Default", "sldId"].includes(name),
});

async function xmlPart(zip: JSZip, file: string, parser: XMLParser) {
    const part = zip.file(file);
    if (!part) throw new Error(`Missing part: ${file}`);
    const xml = await part.async("string");
    if (XMLValidator.validate(xml) !== true) throw new Error(`Invalid XML: ${file}`);
    return parser.parse(xml);
}

interface Relationship {
    "@_Id": string;
    "@_Type": string;
    "@_Target": string;
    "@_TargetMode"?: string;
}

function targetPart(source: string, rel: Relationship): string {
    if (rel["@_TargetMode"] === "External") throw new Error("External presentation part");
    return path.resolve("/", path.dirname(source), rel["@_Target"]).slice(1);
}

async function presentationSlides(zip: JSZip): Promise<string[]> {
    const root = await xmlPart(zip, "_rels/.rels", packageParser);
    const main = (root.Relationships?.Relationship as Relationship[] | undefined)
        ?.find(rel => rel["@_Type"].endsWith("/officeDocument"));
    if (!main) throw new Error("Missing office document relationship");
    const file = targetPart("", main);
    const types = await xmlPart(zip, "[Content_Types].xml", packageParser);
    const overrides = new Map<string, string>((types.Types?.Override ?? []).map(
        (p: Record<string, string>) => [p["@_PartName"], p["@_ContentType"]],
    ));
    const defaults = new Map<string, string>((types.Types?.Default ?? []).map(
        (p: Record<string, string>) => [p["@_Extension"], p["@_ContentType"]],
    ));
    const contentType = (part: string) =>
        overrides.get("/" + part) ?? defaults.get(path.extname(part).slice(1));
    const pptxType = "application/vnd.openxmlformats-officedocument.presentationml.";
    if (contentType(file) !== pptxType + "presentation.main+xml") {
        throw new Error("Not a PowerPoint presentation");
    }

    const doc = await xmlPart(zip, file, packageParser);
    const ids: Record<string, string>[] = doc.presentation?.sldIdLst?.sldId ?? [];
    if (!ids.length) throw new Error("Empty presentation");
    const relFile = path.join(path.dirname(file), "_rels", path.basename(file) + ".rels");
    const rels = await xmlPart(zip, relFile, packageParser);
    const links: Relationship[] = rels.Relationships?.Relationship ?? [];
    return ids.map(node => {
        const key = Object.keys(node).find(k => k.startsWith("@_") && k.endsWith(":id"));
        const rel = key && links.find(r => r["@_Id"] === node[key] && r["@_Type"].endsWith("/slide"));
        if (!rel) throw new Error("Missing slide relationship");
        const slide = targetPart(file, rel);
        if (contentType(slide) !== pptxType + "slide+xml") throw new Error("Invalid slide content type");
        return slide;
    });
}

export async function parsePptx(pptxPath: string): Promise<ParsedPptx> {
    // Read the deck off disk. If it's missing the agent never produced one —
    // return EMPTY(false, …) so the `exec` grader can report MIS.
    let buf: Buffer;
    try {
        buf = await fs.readFile(pptxPath);
    } catch {
        return EMPTY(false, false);
    }

    // A .pptx is a zip archive of XML parts. If it doesn't unzip, the agent
    // wrote something but it's corrupt — `exec` grader reports INV.
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(buf);
    } catch {
        return EMPTY(true, false);
    }

    // Keep XML attributes (ignoreAttributes: false) — they carry the data we
    // need, like font size (a:rPr@sz) and placeholder type (p:ph@type).
    // Prefixing them with @_ keeps them distinguishable from child elements.
    const parser = new XMLParser({
        transformTagName: localName,
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
    });

    // Parse each slide's XML once and run both extractors over the same DOM:
    // structural counts for the code graders, title/body for the coherence judge.
    const perSlide: SlideMetrics[] = [];
    const slideTexts: SlideTexts[] = [];
    try {
        const slides = await presentationSlides(zip);
        for (const [i, file] of slides.entries()) {
            const doc = await xmlPart(zip, file, parser);
            if (pluck(doc, ["sld", "cSld", "spTree"]) == null) {
                return EMPTY(true, true);
            }
            perSlide.push(analyzeSlide(i + 1, doc));
            slideTexts.push(extractSlideTexts(i + 1, doc));
        }
    } catch {
        // A ZIP can open successfully but contain broken relationships or XML.
        return EMPTY(true, true);
    }

    return {
        exists: true,
        validZip: true,
        validPresentation: true,
        slideCount: perSlide.length,
        perSlide,
        slideTexts,
    };
}

function analyzeSlide(index: number, doc: unknown): SlideMetrics {
    // Every visible thing on a slide hangs off p:sld → p:cSld → p:spTree.
    // Count the five top-level shape kinds OOXML defines (text shapes,
    // pictures, charts/tables, groups, connectors) for the clutter metric,
    // and pictures separately for the img% metric.
    const spTree = pluck(doc, ["sld", "cSld", "spTree"]) ?? {};
    const shapeCount =
        countShapes(spTree, "sp") +
        countShapes(spTree, "pic") +
        countShapes(spTree, "graphicFrame") +
        countShapes(spTree, "grpSp") +
        countShapes(spTree, "cxnSp");
    const pictureCount = countShapes(spTree, "pic");

    // Collect every text run (<a:r>) on the slide along with its font size,
    // then concatenate to get total text — feeds the dense and emoji graders.
    const runs: { text: string; sizePt?: number }[] = [];
    walkRuns(doc, runs);
    const text = runs.map((r) => r.text).join("");

    // Distinct font sizes used, ascending — the font<14 grader looks at the
    // smallest one to check the readability floor.
    const fontSizesPt = Array.from(
        new Set(runs.map((r) => r.sizePt).filter((s): s is number => typeof s === "number")),
    ).sort((a, b) => a - b);

    return {
        index,
        shapeCount,
        pictureCount,
        textChars: text.length,
        fontSizesPt,
        emojiCount: (text.match(EMOJI_RE) ?? []).length,
    };
}

/** Safe nested-property lookup through the parsed XML object tree. */
function pluck(node: unknown, keys: string[]): unknown {
    let cur: unknown = node;
    for (const k of keys) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
}

/**
 * Count direct children of `key` under spTree. fast-xml-parser returns a
 * single child as an object and multiple children as an array, so normalise.
 */
function countShapes(spTree: unknown, key: string): number {
    if (spTree == null || typeof spTree !== "object") return 0;
    const v = (spTree as Record<string, unknown>)[key];
    if (v == null) return 0;
    return Array.isArray(v) ? v.length : 1;
}

/**
 * Recursively collect every DrawingML text run (<a:r>) under `node`.
 * Each run contributes its literal text (<a:t>) and optional font size
 * (<a:rPr sz="…">, in hundredths of a point — divide by 100).
 */
function walkRuns(node: unknown, out: { text: string; sizePt?: number }[]): void {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const v of node) walkRuns(v, out);
        return;
    }
    const obj = node as Record<string, unknown>;
    // Extract this element's own runs, if any.
    const r = obj["r"];
    if (r != null) {
        const arr = Array.isArray(r) ? r : [r];
        for (const run of arr) {
            if (run == null || typeof run !== "object") continue;
            const runObj = run as Record<string, unknown>;
            const t = runObj["t"];
            const text = typeof t === "string" ? t : t == null ? "" : String(t);
            const rPr = runObj["rPr"];
            const sizeAttr =
                rPr && typeof rPr === "object" ? (rPr as Record<string, unknown>)["@_sz"] : undefined;
            const sizePt = sizeAttr != null ? Number(sizeAttr) / 100 : undefined;
            out.push({ text, sizePt });
        }
    }
    // Recurse into child elements (skip XML attributes and the runs we just handled).
    for (const k of Object.keys(obj)) {
        if (k.startsWith("@_") || k === "r") continue;
        walkRuns(obj[k], out);
    }
}

// Title/body extraction for the title-content alignment judge.
//
// Heuristic for picking the title text on a slide, in priority order:
//   1. The first shape whose placeholder type is "title" or "ctrTitle"
//      (that's how python-pptx and Office mark title placeholders).
//   2. Otherwise, the shape with the largest font run (max sz attribute).
//   3. Otherwise, the first shape with non-empty text.
// Body = concatenation of every other shape's text on the slide.
interface SlideShape {
    phType?: string;
    text: string;
    maxSizePt: number;
}

/**
 * Flatten each text shape (<p:sp>) on the slide to {placeholder type, full
 * text, largest font size} — the three signals the title heuristic needs.
 */
function collectShapes(spTree: unknown): SlideShape[] {
    const out: SlideShape[] = [];
    if (spTree == null || typeof spTree !== "object") return out;
    const sps = (spTree as Record<string, unknown>)["sp"];
    if (sps == null) return out;
    const arr = Array.isArray(sps) ? sps : [sps];
    for (const sp of arr) {
        if (sp == null || typeof sp !== "object") continue;
        // Placeholder type ("title", "ctrTitle", "body", …) is buried under
        // the shape's non-visual properties at p:nvSpPr → p:nvPr → p:ph@type.
        const ph = pluck(sp, ["nvSpPr", "nvPr", "ph"]);
        const phType =
            ph && typeof ph === "object" ? (ph as Record<string, unknown>)["@_type"] : undefined;
        // Gather this shape's text runs and their sizes from its <p:txBody>.
        const runs: { text: string; sizePt?: number }[] = [];
        walkRuns((sp as Record<string, unknown>)["txBody"], runs);
        const text = runs
            .map((r) => r.text)
            .join("")
            .trim();
        const sizes = runs.map((r) => r.sizePt).filter((s): s is number => typeof s === "number");
        out.push({
            phType: phType != null ? String(phType) : undefined,
            text,
            maxSizePt: sizes.length > 0 ? Math.max(...sizes) : 0,
        });
    }
    return out;
}

function extractSlideTexts(index: number, doc: unknown): SlideTexts {
    const spTree = pluck(doc, ["sld", "cSld", "spTree"]) ?? {};
    const shapes = collectShapes(spTree).filter((s) => s.text.length > 0);

    // Apply the heuristic documented above: explicit title placeholder first,
    // else the shape with the biggest font, else whatever comes first.
    let titleShape: SlideShape | undefined = shapes.find(
        (s) => s.phType === "title" || s.phType === "ctrTitle",
    );
    if (!titleShape) {
        const byFont = [...shapes].sort((a, b) => b.maxSizePt - a.maxSizePt);
        titleShape = byFont[0];
    }
    // Title = that shape's text; body = everything else, newline-joined.
    const title = titleShape?.text ?? "";
    const body = shapes
        .filter((s) => s !== titleShape)
        .map((s) => s.text)
        .join("\n");
    return { index, title, body };
}
