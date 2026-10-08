// PROTOTYPE ONLY — deterministic mock image content (data-simulated="SIMULATED OUTPUT").
//
// The catalogue has no thumbnails yet (every `thumbnails` array is empty) and the locale proxy
// would redirect files under public/, so the click dummy draws its image content as inline SVG.
// Every capability shows the same subject — a person at a table with a plant — so the cards are
// comparable (04.2: comparable source subjects). The art deliberately avoids cobalt hues: in this
// interface blue means state, so product imagery must not carry it.

const P = {
  wall: "#e7e1d3",
  window: "#cfd5c4",
  windowFrame: "#b9b39f",
  table: "#c9b79b",
  tableEdge: "#a8957a",
  skin: "#dfb390",
  skinShade: "#c99772",
  hair: "#3a2c25",
  sweater: "#ad5f45",
  sweaterShade: "#8f4b36",
  pot: "#8e5f40",
  leaf: "#6a7a52",
  leafDark: "#56653f",
  mug: "#efe9dc",
  ink: "#1d1c1a",
  paper: "#f6f2e8",
} as const;

/** Fixed precision: Math.cos/sin may differ in the last digit between server and browser (hydration). */
const r2 = (n: number) => n.toFixed(2);

const svg = (body: string, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="960" height="960">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;

/** The shared subject. `s` scales around the centre-bottom, `dx/dy` move it. */
function subject(o: { skin?: string; hair?: string; sweater?: string; shade?: string; stroke?: string; sw?: number } = {}) {
  const skin = o.skin ?? P.skin;
  const hair = o.hair ?? P.hair;
  const sweater = o.sweater ?? P.sweater;
  const shade = o.shade ?? P.sweaterShade;
  const st = o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 2}" stroke-linejoin="round"` : "";
  return `
    <path d="M70 240 C72 192 92 170 120 170 C148 170 168 192 170 240 Z" fill="${sweater}"${st}/>
    <path d="M120 170 C140 170 158 182 166 206 L170 240 L148 240 C148 214 138 190 120 182 Z" fill="${shade}" opacity=".55"/>
    <rect x="110" y="150" width="20" height="24" fill="${skin}"${st}/>
    <ellipse cx="120" cy="124" rx="29" ry="34" fill="${skin}"${st}/>
    <path d="M91 122 C88 94 104 82 122 82 C142 82 154 96 150 124 C146 108 136 100 120 101 C104 102 96 110 91 122 Z" fill="${hair}"${st}/>
    <ellipse cx="109" cy="127" rx="2.4" ry="3" fill="${P.ink}"/>
    <ellipse cx="131" cy="127" rx="2.4" ry="3" fill="${P.ink}"/>
    <path d="M112 145 Q120 151 128 145" fill="none" stroke="${P.ink}" stroke-width="2" stroke-linecap="round"/>`;
}

function plant(x = 38, y = 172, leaf: string = P.leaf, pot: string = P.pot) {
  return `
    <path d="M${x - 14} ${y} h28 l-4 30 h-20 Z" fill="${pot}"/>
    <path d="M${x} ${y} C${x - 24} ${y - 10} ${x - 26} ${y - 34} ${x - 10} ${y - 44} C${x - 8} ${y - 26} ${x - 4} ${y - 14} ${x} ${y} Z" fill="${leaf}"/>
    <path d="M${x} ${y} C${x + 22} ${y - 12} ${x + 24} ${y - 38} ${x + 8} ${y - 50} C${x + 6} ${y - 30} ${x + 2} ${y - 16} ${x} ${y} Z" fill="${P.leafDark}"/>`;
}

function room(wall: string = P.wall, win: string = P.window) {
  return `
    <rect width="240" height="240" fill="${wall}"/>
    <rect x="150" y="26" width="66" height="96" fill="${win}" stroke="${P.windowFrame}" stroke-width="4"/>
    <path d="M183 26 v96 M150 74 h66" stroke="${P.windowFrame}" stroke-width="3"/>
    <rect x="0" y="200" width="240" height="40" fill="${P.table}"/>
    <rect x="0" y="200" width="240" height="4" fill="${P.tableEdge}"/>`;
}

const mug = (x = 190, y = 186) =>
  `<rect x="${x}" y="${y}" width="22" height="22" fill="${P.mug}" stroke="${P.tableEdge}" stroke-width="1.5"/><path d="M${x + 22} ${y + 6} h6 v10 h-6" fill="none" stroke="${P.tableEdge}" stroke-width="2"/>`;

const grain = (id: string, opacity = 0.18) =>
  `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${opacity} 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;

const lines = (x: number, y: number, widths: number[], color: string = P.ink, h = 4, gap = 9) =>
  widths.map((w, i) => `<rect x="${x}" y="${y + i * gap}" width="${w}" height="${h}" fill="${color}"/>`).join("");

const DEMO = svg(`${room()}${plant()}${subject()}${mug()}
  <rect width="240" height="240" filter="url(#g)" opacity=".9"/>`, grain("g", 0.12));

const ART: Record<string, string> = {
  bricktoy: svg(
    `<rect width="240" height="240" fill="#d9d2bf"/>
     <rect x="0" y="196" width="240" height="44" fill="#7f8b62"/>
     ${Array.from({ length: 12 }, (_, i) => `<rect x="${6 + i * 20}" y="190" width="10" height="6" fill="#6f7a54"/>`).join("")}
     <rect x="150" y="30" width="64" height="88" fill="#c3c7b0" stroke="#9d9a83" stroke-width="6"/>
     <rect x="86" y="164" width="68" height="40" fill="${P.sweater}" stroke="#7d4130" stroke-width="2"/>
     <rect x="70" y="168" width="18" height="34" fill="${P.sweaterShade}" stroke="#7d4130" stroke-width="2"/>
     <rect x="152" y="168" width="18" height="34" fill="${P.sweaterShade}" stroke="#7d4130" stroke-width="2"/>
     <rect x="108" y="152" width="24" height="12" fill="${P.skinShade}"/>
     <rect x="96" y="102" width="48" height="50" fill="#e6bd7a" stroke="#b8904f" stroke-width="2"/>
     <rect x="108" y="92" width="24" height="10" fill="#e6bd7a" stroke="#b8904f" stroke-width="2"/>
     <path d="M94 104 h52 v-10 h-52 Z" fill="${P.hair}"/>
     <circle cx="111" cy="124" r="3.4" fill="${P.ink}"/><circle cx="129" cy="124" r="3.4" fill="${P.ink}"/>
     <path d="M110 138 Q120 146 130 138" fill="none" stroke="${P.ink}" stroke-width="2.4" stroke-linecap="round"/>
     <rect x="24" y="170" width="30" height="26" fill="${P.pot}" stroke="#6e472f" stroke-width="2"/>
     <rect x="22" y="138" width="16" height="16" fill="${P.leaf}"/><rect x="40" y="128" width="16" height="16" fill="${P.leafDark}"/><rect x="30" y="152" width="16" height="16" fill="${P.leaf}"/>
     ${[30, 46].map((x) => `<rect x="${x - 4}" y="164" width="8" height="6" fill="#7a5034"/>`).join("")}`,
  ),
  manga: svg(
    `<rect width="240" height="240" fill="#fbfaf6"/>
     ${Array.from({ length: 28 }, (_, i) => {
       const a = (i / 28) * Math.PI * 2;
       return `<path d="M${r2(120 + Math.cos(a) * 140)} ${r2(124 + Math.sin(a) * 140)} L${r2(120 + Math.cos(a) * 92)} ${r2(124 + Math.sin(a) * 92)}" stroke="${P.ink}" stroke-width="${i % 3 === 0 ? 2 : 1}"/>`;
     }).join("")}
     <path d="M70 240 C72 192 92 170 120 170 C148 170 168 192 170 240 Z" fill="url(#tone)" stroke="${P.ink}" stroke-width="2.6"/>
     <rect x="110" y="150" width="20" height="24" fill="#fff" stroke="${P.ink}" stroke-width="2.6"/>
     <path d="M91 124 C91 160 108 160 120 160 C132 160 149 160 149 124 C149 96 136 90 120 90 C104 90 91 96 91 124 Z" fill="#fff" stroke="${P.ink}" stroke-width="2.6"/>
     <path d="M84 128 L92 92 L104 104 L110 80 L122 98 L134 78 L140 102 L154 90 L156 130 C150 110 138 104 120 104 C104 104 92 112 84 128 Z" fill="${P.ink}"/>
     <ellipse cx="108" cy="128" rx="5" ry="7" fill="${P.ink}"/><ellipse cx="132" cy="128" rx="5" ry="7" fill="${P.ink}"/>
     <circle cx="110" cy="125" r="2" fill="#fff"/><circle cx="134" cy="125" r="2" fill="#fff"/>
     <path d="M114 148 Q120 152 126 148" fill="none" stroke="${P.ink}" stroke-width="2" stroke-linecap="round"/>`,
    `<pattern id="tone" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#fff"/><circle cx="3" cy="3" r="1.3" fill="${P.ink}"/></pattern>`,
  ),
  actionfigure: svg(
    `<rect width="240" height="240" fill="#d8cdb4"/>
     <rect x="34" y="14" width="172" height="216" fill="#c7843f" stroke="#8a5a2a" stroke-width="3"/>
     <rect x="34" y="14" width="172" height="34" fill="${P.ink}"/>
     ${lines(52, 26, [70], "#f2e6cc", 6)}${lines(140, 27, [48], "#c7843f", 4)}
     <rect x="54" y="58" width="132" height="160" fill="#efe6d2" opacity=".55" stroke="#fff" stroke-width="3"/>
     <g transform="translate(60 74) scale(.5)">${subject({ stroke: "#5a3d2a", sw: 3 })}</g>
     <rect x="128" y="150" width="44" height="54" fill="#e3d5b6" stroke="#8a5a2a" stroke-width="2"/>
     <g transform="translate(136 108) scale(.55)">${plant(26, 150)}</g>
     <path d="M58 62 L70 62 M58 62 L58 74" stroke="#fff" stroke-width="3"/>`,
  ),
  miniature: svg(
    `<rect width="240" height="240" fill="#e4dcc6"/>
     <path d="M0 160 L120 128 L240 160 L240 240 L0 240 Z" fill="#8c9a62"/>
     <path d="M30 172 L120 150 L210 172 L120 196 Z" fill="${P.table}" stroke="${P.tableEdge}" stroke-width="2"/>
     ${[46, 196, 64, 178].map((x, i) => `<circle cx="${x}" cy="${150 + (i % 2) * 6}" r="${10 + (i % 2) * 3}" fill="${i % 2 ? P.leafDark : P.leaf}"/><rect x="${x - 2}" y="${158 + (i % 2) * 6}" width="4" height="10" fill="${P.pot}"/>`).join("")}
     <g transform="translate(84 104) scale(.3)">${subject()}</g>
     <g transform="translate(130 128) scale(.32)">${plant(38, 172)}</g>
     <rect width="240" height="70" fill="#e4dcc6" opacity=".55" filter="url(#b)"/>
     <rect y="196" width="240" height="44" fill="#7a8754" opacity=".5" filter="url(#b)"/>`,
    `<filter id="b"><feGaussianBlur stdDeviation="6"/></filter>`,
  ),
  mindmap: svg(
    `<rect width="240" height="240" fill="${P.paper}"/>
     ${[
       [42, 46],
       [198, 52],
       [36, 188],
       [204, 182],
       [120, 214],
     ]
       .map(
         ([x, y]) =>
           `<path d="M120 116 L${x} ${y}" stroke="${P.ink}" stroke-width="1.6"/><rect x="${x - 30}" y="${y - 12}" width="60" height="24" fill="#fff" stroke="${P.ink}" stroke-width="1.6"/>${lines(x - 22, y - 3, [44], "#8e8a80", 3)}${lines(x - 22, y + 4, [28], "#b9b4a8", 3)}`,
       )
       .join("")}
     <circle cx="120" cy="116" r="40" fill="${P.wall}" stroke="${P.ink}" stroke-width="2"/>
     <g transform="translate(84 76) scale(.3)">${subject()}</g>`,
  ),
  lerncomic: svg(
    `<rect width="240" height="240" fill="${P.ink}"/>
     ${[
       [6, 6],
       [122, 6],
       [6, 122],
       [122, 122],
     ]
       .map(
         ([x, y], i) =>
           `<rect x="${x}" y="${y}" width="112" height="112" fill="${i % 3 === 0 ? P.wall : P.paper}"/>
            <g transform="translate(${x + 14 + (i % 2) * 10} ${y + 34}) scale(.36)">${subject()}</g>
            <path d="M${x + 58} ${y + 10} h46 v26 h-30 l-8 8 v-8 h-8 Z" fill="#fff" stroke="${P.ink}" stroke-width="1.5"/>
            ${lines(x + 64, y + 17, [34, 22], "#6d685e", 3, 7)}
            ${i === 2 ? plant(x + 92, y + 98) : ""}`,
       )
       .join("")}`,
  ),
  infographic: svg(
    `<rect width="240" height="240" fill="${P.paper}"/>
     <rect x="14" y="14" width="212" height="22" fill="${P.ink}"/>${lines(22, 22, [96], "#e9e3d4", 6)}
     <rect x="14" y="48" width="84" height="100" fill="${P.wall}"/>
     <g transform="translate(14 60) scale(.36)">${subject()}</g>
     ${[0, 1, 2, 3].map((i) => `<rect x="112" y="${54 + i * 24}" width="${[96, 64, 80, 40][i]}" height="12" fill="${[P.sweater, P.leaf, P.pot, P.skinShade][i]}"/>${lines(112, 69 + i * 24, [48], "#a19c90", 3)}`).join("")}
     ${[0, 1, 2].map((i) => `<rect x="${14 + i * 72}" y="162" width="64" height="64" fill="#fff" stroke="#c9c3b6"/><circle cx="${46 + i * 72}" cy="184" r="12" fill="none" stroke="${P.ink}" stroke-width="2"/>${lines(24 + i * 72, 204, [44, 30], "#8e8a80", 3, 7)}`).join("")}`,
  ),
  storyboard: svg(
    `<rect width="240" height="240" fill="${P.paper}"/>
     ${[0, 1, 2].map((i) => {
       const x = 10 + i * 78;
       return `<rect x="${x}" y="58" width="66" height="66" fill="#fff" stroke="${P.ink}" stroke-width="1.6"/>
         <g transform="translate(${x + [8, 16, 2][i]} ${[74, 82, 64][i]}) scale(${[0.24, 0.2, 0.3][i]})" opacity=".85">${subject({ skin: "#e9e4da", hair: "#5b5650", sweater: "#b8b2a6", shade: "#a49e92" })}</g>
         ${lines(x, 132, [60, 44, 52], "#8e8a80", 3, 8)}
         ${i < 2 ? `<path d="M${x + 68} 91 h8 m-4 -4 l4 4 -4 4" stroke="${P.ink}" stroke-width="1.6" fill="none"/>` : ""}
         <rect x="${x}" y="44" width="18" height="10" fill="${P.ink}"/>`;
     }).join("")}
     ${lines(10, 182, [140, 96], "#b9b4a8", 3, 9)}`,
  ),
  "35mm": svg(
    `<rect width="240" height="240" fill="#141210"/>
     ${Array.from({ length: 10 }, (_, i) => `<rect x="${8 + i * 23}" y="8" width="12" height="9" fill="#e9dcc0"/><rect x="${8 + i * 23}" y="223" width="12" height="9" fill="#e9dcc0"/>`).join("")}
     <svg x="8" y="26" width="224" height="188" viewBox="0 20 240 200" preserveAspectRatio="xMidYMid slice">
       <g filter="url(#warm)">${room("#e9d6b8", "#d9cfae")}${plant()}${subject()}${mug()}</g>
       <rect x="0" y="0" width="240" height="240" filter="url(#g35)"/>
     </svg>`,
    `<filter id="warm"><feColorMatrix type="matrix" values="1.08 .05 0 0 .02  .02 .98 .02 0 .01  0 .04 .78 0 0  0 0 0 1 0"/></filter>${grain("g35", 0.32)}`,
  ),
  cinematic: svg(
    `<rect width="240" height="240" fill="#0d0c0b"/>
     <svg x="0" y="44" width="240" height="152" viewBox="0 40 240 160" preserveAspectRatio="xMidYMid slice">
       <g filter="url(#grade)">${room("#5e5a4e", "#9a8b62")}${plant()}${subject()}</g>
       <rect width="240" height="240" fill="url(#vig)"/>
     </svg>`,
    `<filter id="grade"><feColorMatrix type="matrix" values=".9 .12 0 0 .02  .05 .82 .05 0 0  0 .1 .62 0 0  0 0 0 1 0"/><feComponentTransfer><feFuncR type="gamma" exponent="1.25"/><feFuncG type="gamma" exponent="1.3"/><feFuncB type="gamma" exponent="1.4"/></feComponentTransfer></filter>
     <radialGradient id="vig" cx=".55" cy=".45" r=".7"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></radialGradient>`,
  ),
  editorial: svg(
    `<rect width="240" height="240" fill="#f3efe6"/>
     <svg x="0" y="0" width="150" height="240" viewBox="45 60 150 180" preserveAspectRatio="xMidYMid slice">
       <g filter="url(#mono)">${room("#d9d3c6", "#c6c4b8")}${subject()}</g>
     </svg>
     <rect x="160" y="18" width="66" height="30" fill="${P.ink}"/>
     ${lines(160, 64, [66, 58, 66, 40], P.ink, 3, 8)}
     ${lines(160, 110, [66, 66, 60, 66, 50, 66, 62, 44], "#8e8a80", 2, 7)}
     <rect x="160" y="178" width="66" height="1" fill="${P.ink}"/>
     ${lines(160, 188, [30], P.sweater, 3)}`,
    `<filter id="mono"><feColorMatrix type="saturate" values=".35"/><feComponentTransfer><feFuncR type="linear" slope="1.12" intercept="-.05"/><feFuncG type="linear" slope="1.12" intercept="-.05"/><feFuncB type="linear" slope="1.12" intercept="-.05"/></feComponentTransfer></filter>`,
  ),
  prophoto: svg(
    `<rect width="240" height="240" fill="url(#seam)"/>
     <ellipse cx="120" cy="226" rx="90" ry="10" fill="#000" opacity=".12"/>
     <g filter="url(#crisp)">${subject()}</g>
     <rect x="186" y="18" width="40" height="56" fill="#fbfaf6" opacity=".7"/>
     <path d="M206 74 v20" stroke="#8e8a80" stroke-width="2"/>`,
    `<linearGradient id="seam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d7d4cc"/><stop offset=".7" stop-color="#ebe8e1"/><stop offset="1" stop-color="#cfcbc1"/></linearGradient>
     <filter id="crisp"><feComponentTransfer><feFuncR type="linear" slope="1.06" intercept="-.02"/><feFuncG type="linear" slope="1.06" intercept="-.02"/><feFuncB type="linear" slope="1.06" intercept="-.02"/></feComponentTransfer></filter>`,
  ),
};

export const svgDataUrl = (markup: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

/** Thumbnail / simulated result for the demo source. Unknown ids fall back to the demo source. */
export function capabilityArt(commandId: string): string {
  return ART[commandId] ?? DEMO;
}

export const DEMO_SOURCE_SVG = DEMO;
export const DEMO_SOURCE_URL = svgDataUrl(DEMO);

/**
 * Treatment applied to an uploaded photo to simulate a result locally. Values are CSS filter
 * strings (also used by canvas `ctx.filter` for Download) plus an overlay kind for the frame.
 */
export const LOCAL_TREATMENT: Record<string, { filter: string; frame: "none" | "film" | "letterbox" | "package" | "panels" | "labels" | "tone" | "studs" | "tilt" | "column" }> = {
  bricktoy: { filter: "saturate(1.4) contrast(1.15)", frame: "studs" },
  manga: { filter: "grayscale(1) contrast(1.8) brightness(1.1)", frame: "tone" },
  actionfigure: { filter: "saturate(1.25) contrast(1.1)", frame: "package" },
  miniature: { filter: "saturate(1.45) contrast(1.08)", frame: "tilt" },
  mindmap: { filter: "grayscale(.6) brightness(1.08)", frame: "labels" },
  lerncomic: { filter: "saturate(1.2) contrast(1.25)", frame: "panels" },
  infographic: { filter: "grayscale(.5) contrast(1.05)", frame: "labels" },
  storyboard: { filter: "grayscale(1) contrast(1.2) brightness(1.15)", frame: "panels" },
  "35mm": { filter: "sepia(.28) contrast(1.06) saturate(1.08)", frame: "film" },
  cinematic: { filter: "contrast(1.18) saturate(.82) brightness(.9) sepia(.15)", frame: "letterbox" },
  editorial: { filter: "grayscale(.65) contrast(1.15)", frame: "column" },
  prophoto: { filter: "contrast(1.08) brightness(1.04) saturate(1.04)", frame: "none" },
};
