# Thai Garuda document graphic

The bundled black Garuda is the original **800 × 800 transparent PNG** used in the
reviewed document mockup. The pixels are preserved without tracing, resampling or
AI-generated detail. The application code's MIT license does not grant authority
to issue official letters or authorize use of state symbols. Staff must use their
agency's approved form and process.

## Graphic source and reproducibility

- Public source: [kruth02.png](https://github.com/sooksun/nextoffice/blob/846bd7ae83fff94203bf628bc4943feef5345e75/apps/api/src/stamps/fonts/kruth02.png).
- Source commit: `846bd7ae83fff94203bf628bc4943feef5345e75`.
- Original bytes: **147,418**, RGBA **800 × 800 pixels**, square image frame.
- The visible emblem fills the image height; transparent horizontal margins are
  retained. Both exports preserve the frame's aspect ratio at the specified height.
- PNG SHA-256: `b04394193c54c754c53eb91d30df47adc3f745124ed241283a732f9b2e526be0`.
- Encoded directly in `desktop/electron/garuda-image.ts` for offline exports.
  Tests verify the embedded bytes, original resolution and physical dimensions.
- The source repository does not supply an explicit license for this image.
  This notice records provenance; it does not relicense the image under MIT or
  represent an agency's approval of its use. No source application code, private
  signature or complete regulation is bundled.

This high-resolution image replaces the coarse drawing extracted from a scanned
legislative copy during export development. It adds about 147 KB of binary image
content to an emblem-bearing document, with no network request during export.

## Historical sizing reference

- Royal Gazette, volume 122, special part 99 Ngor, **23 September 2548 (2005)**.
- Physical heights: rule 71, PDF page 28: 3 cm and 1.5 cm.
- Drawing comparison: appendix **form 26**, PDF page 57 (appendix printed page 26).
- Public historical mirror: [saraban1.pdf](https://github.com/sooksun/nextoffice/blob/846bd7ae83fff94203bf628bc4943feef5345e75/docs/saraban1.pdf).
- Mirror commit: `846bd7ae83fff94203bf628bc4943feef5345e75`.
- PDF SHA-256: `d63a601b0ddbabc97949d5415107908f2182ddee907b68ffaf439083cbbf8765`.

The historical sizing reference is distinct from the PNG's source above; the PNG
is not claimed to have been extracted from this scanned PDF.

## Working layouts

- Memo/internal letter: 1.5 cm high, left letterhead, first page only.
- External letter, including invitation/reply/coordination: 3 cm high, centered
  on the A4 page, first page only.
- TOR, project proposal, minutes and generic drafts: no automatic Garuda.
- An explicit **No Garuda emblem** option supports other agency forms.

These are working layouts, not certification of a current agency form or a legal
compliance opinion. Current agency templates and amendments remain to be checked
before issuing a document.
