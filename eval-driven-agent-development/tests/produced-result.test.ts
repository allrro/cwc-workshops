import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";

import { GRADERS } from "../src/graders.js";
import { parsePptx } from "../src/parse-pptx.js";
import type { GraderContext } from "../src/graders/types.js";

const fixture = new URL("./fixtures/transformers.pptx", import.meta.url);
let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "pptx-grader-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

async function grade(path: string) {
    const parsedPptx = await parsePptx(path);
    const grader = GRADERS.find(g => g.name === "Produced result")!;
    return grader.grade({ parsedPptx } as GraderContext);
}

test("actual five-slide model output passes", async () => {
    const path = join(dir, "actual.pptx");
    await writeFile(path, await readFile(fixture));
    assert.equal(await grade(path), "ok");
    assert.equal((await parsePptx(path)).slideCount, 5);
});

test("ordinary ZIP renamed to .pptx is invalid", async () => {
    const zip = new JSZip();
    zip.file("unrelated.txt", "not a presentation");
    const path = join(dir, "ordinary.pptx");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(await grade(path), "invalid");
});

test("a real deck with a missing referenced slide is invalid", async () => {
    const zip = await JSZip.loadAsync(await readFile(fixture));
    zip.remove("ppt/slides/slide2.xml");
    const path = join(dir, "broken.pptx");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(await grade(path), "invalid");
});

test("missing and corrupt inputs have distinct grades", async () => {
    assert.equal(await grade(join(dir, "absent.pptx")), "missing");
    const path = join(dir, "corrupt.pptx");
    await writeFile(path, "not a ZIP");
    assert.equal(await grade(path), "invalid");
});
