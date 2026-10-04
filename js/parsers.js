// Turns PDF and EPUB files into a simple structure the reader can speak:
//   { title, sections: [{ title, paragraphs: [{ text, kind }] }] }
// kind is "p" for body text or "h" for headings.

import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

const clean = (s) => s.replace(/­/g, "").replace(/\s+/g, " ").trim();

export async function parseBook(file, onProgress = () => {}) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return parsePdf(file, onProgress);
  if (name.endsWith(".epub")) return parseEpub(file, onProgress);
  if (name.endsWith(".txt")) return parseTxt(file);
  throw new Error("Only PDF, EPUB and TXT files are supported.");
}

// ---------- TXT ----------

async function parseTxt(file) {
  const text = await file.text();
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(clean)
    .filter(Boolean)
    .map((t) => ({ text: t, kind: "p" }));
  return { title: file.name.replace(/\.txt$/i, ""), sections: [{ title: "Text", paragraphs }] };
}

// ---------- PDF ----------

async function parsePdf(file, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let title = file.name.replace(/\.pdf$/i, "");
  try {
    const meta = await pdf.getMetadata();
    if (meta?.info?.Title && meta.info.Title.trim().length > 2) title = meta.info.Title.trim();
  } catch {}

  const sections = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    sections.push({ title: `Page ${n}`, paragraphs: pdfPageToParagraphs(content.items) });
    page.cleanup();
    onProgress(n / pdf.numPages);
  }
  await pdf.destroy();

  // Drop empty pages (e.g. scanned images with no text layer) but keep page numbers in titles.
  const nonEmpty = sections.filter((s) => s.paragraphs.length);
  if (!nonEmpty.length) {
    throw new Error(
      "This PDF has no selectable text (it is probably scanned images). Run it through an OCR tool first, then try again."
    );
  }
  return { title, sections: nonEmpty };
}

// Group pdf.js text items into lines, then lines into paragraphs using vertical gaps.
function pdfPageToParagraphs(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!("str" in it)) continue;
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    if (!cur || Math.abs(cur.y - y) > h * 0.5) {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { y, h, text: "" };
    }
    // pdf.js sometimes splits one word into several items; only add a space where there's a visible gap.
    if (cur.text && it.str && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && needsSpace(cur, it)) {
      cur.text += " ";
    }
    cur.text += it.str;
    cur.lastX = it.transform[4] + (it.width || 0);
    if (it.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  if (!lines.length) return [];

  // Typical spacing between lines on this page.
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
  const bodyH = [...lines].map((l) => l.h).sort((a, b) => a - b)[Math.floor(lines.length / 2)];

  const paragraphs = [];
  let buf = "";
  let bufIsHeading = false;
  const flush = () => {
    const t = clean(buf);
    if (t && !/^\d{1,4}$/.test(t)) paragraphs.push({ text: t, kind: bufIsHeading ? "h" : "p" });
    buf = "";
  };
  lines.forEach((line, i) => {
    const text = line.text.trim();
    const isHeading = line.h > bodyH * 1.25 && text.length < 120;
    const prev = lines[i - 1];
    const gap = prev ? prev.y - line.y : 0;
    const newPara = !prev || gap > median * 1.45 || gap < 0 || isHeading !== bufIsHeading;
    if (newPara) {
      flush();
      bufIsHeading = isHeading;
      buf = text;
    } else if (/[A-Za-z]-$/.test(buf)) {
      buf = buf.slice(0, -1) + text; // re-join hyphenated words across lines
    } else {
      buf += " " + text;
    }
  });
  flush();
  return paragraphs;
}

function needsSpace(line, item) {
  if (line.lastX == null) return false;
  const gap = item.transform[4] - line.lastX;
  return gap > (Math.abs(item.transform[0]) || 10) * 0.15;
}

// ---------- EPUB ----------

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "DD", "DT", "FIGCAPTION", "TD", "TH",
]);
const HEADING = /^H[1-6]$/;

async function parseEpub(file, onProgress) {
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const read = async (path) => {
    const f = zip.file(path) || zip.file(decodeURIComponent(path));
    if (!f) throw new Error(`Missing file in EPUB: ${path}`);
    return f.async("string");
  };
  const xml = (s, type = "application/xml") => new DOMParser().parseFromString(s, type);

  const container = xml(await read("META-INF/container.xml"));
  const opfPath = container.querySelector("rootfile").getAttribute("full-path");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opf = xml(await read(opfPath));

  const titleEl = opf.getElementsByTagNameNS("*", "title")[0];
  const title = titleEl?.textContent?.trim() || file.name.replace(/\.epub$/i, "");

  const manifest = {};
  for (const item of opf.getElementsByTagNameNS("*", "item")) {
    manifest[item.getAttribute("id")] = {
      href: resolvePath(opfDir, item.getAttribute("href")),
      type: item.getAttribute("media-type"),
      props: item.getAttribute("properties") || "",
    };
  }
  const tocTitles = await readTocTitles(opf, manifest, read, xml);
  const spine = [...opf.getElementsByTagNameNS("*", "itemref")]
    .map((r) => manifest[r.getAttribute("idref")])
    .filter((m) => m && /html/.test(m.type));

  const sections = [];
  for (let i = 0; i < spine.length; i++) {
    const { href } = spine[i];
    let doc;
    try {
      doc = xml(await read(href), "application/xhtml+xml");
      if (doc.querySelector("parsererror")) doc = xml(await read(href), "text/html");
    } catch {
      continue;
    }
    const paragraphs = htmlToParagraphs(doc.body || doc.documentElement);
    if (paragraphs.length) {
      const firstHeading = paragraphs.find((p) => p.kind === "h")?.text;
      sections.push({
        title: tocTitles[href] || firstHeading || `Section ${sections.length + 1}`,
        paragraphs,
      });
    }
    onProgress((i + 1) / spine.length);
  }
  if (!sections.length) throw new Error("Couldn't find any text in this EPUB.");
  return { title, sections };
}

function resolvePath(base, href) {
  const parts = (base + href.split("#")[0]).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  return out.join("/");
}

async function readTocTitles(opf, manifest, read, xml) {
  const titles = {};
  try {
    const nav = Object.values(manifest).find((m) => m.props.includes("nav"));
    if (nav) {
      const doc = xml(await read(nav.href), "application/xhtml+xml");
      const dir = nav.href.includes("/") ? nav.href.slice(0, nav.href.lastIndexOf("/") + 1) : "";
      for (const a of doc.getElementsByTagNameNS("*", "a")) {
        const href = resolvePath(dir, a.getAttribute("href") || "");
        if (!titles[href]) titles[href] = clean(a.textContent);
      }
      return titles;
    }
    const tocId = opf.getElementsByTagNameNS("*", "spine")[0]?.getAttribute("toc");
    const ncx = tocId && manifest[tocId];
    if (ncx) {
      const doc = xml(await read(ncx.href));
      const dir = ncx.href.includes("/") ? ncx.href.slice(0, ncx.href.lastIndexOf("/") + 1) : "";
      for (const np of doc.getElementsByTagNameNS("*", "navPoint")) {
        const label = np.getElementsByTagNameNS("*", "text")[0]?.textContent;
        const src = np.getElementsByTagNameNS("*", "content")[0]?.getAttribute("src");
        if (label && src) {
          const href = resolvePath(dir, src);
          if (!titles[href]) titles[href] = clean(label);
        }
      }
    }
  } catch {}
  return titles;
}

// Walk the chapter HTML and collect text from block elements in reading order.
function htmlToParagraphs(root) {
  const out = [];
  const walk = (el) => {
    for (const child of el.children) {
      const tag = child.tagName.toUpperCase().replace(/^.*:/, "");
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NAV") continue;
      if (BLOCK_TAGS.has(tag) && !hasBlockChild(child)) {
        const text = clean(child.textContent || "");
        if (text) out.push({ text, kind: HEADING.test(tag) ? "h" : "p" });
      } else if (child.children.length) {
        // A div that mixes loose text with child elements: take its own text too.
        const own = clean(
          [...child.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ")
        );
        if (own && !hasBlockChild(child)) out.push({ text: clean(child.textContent), kind: "p" });
        else walk(child);
      } else {
        const text = clean(child.textContent || "");
        if (text && tag === "DIV") out.push({ text, kind: "p" });
      }
    }
  };
  walk(root);
  return out;
}

function hasBlockChild(el) {
  for (const c of el.children) {
    const tag = c.tagName.toUpperCase().replace(/^.*:/, "");
    if (BLOCK_TAGS.has(tag) || tag === "DIV" || tag === "SECTION") return true;
  }
  return false;
}
