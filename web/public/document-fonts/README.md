# Document font resources

The application bundles unmodified TH Sarabun New and TH SarabunPSK font files for offline, editable DOCX embedding. Each family includes regular, bold, italic and bold-italic faces. `manifest.json` pins every file by SHA-256; the exporter also pins the manifest and checks the bytes before embedding.

The files were obtained from the owner's installed Windows fonts on 2026-10-15. Their internal family names and embedding permissions were inspected before bundling. No font is installed into the operating system. Font selection always uses the actual internal family name: TH SarabunPSK is never represented as TH Sarabun New.

- TH Sarabun New: copyright SIPA, created by Suppakit CHALERMLARP, GPL-2.0-or-later with the document embedding exception reproduced in `sarabun-new-LICENSE.txt`. The GPL text is included in `GPL-2.0.txt`.
- TH SarabunPSK: copyright DIP/SIPA, created by Suppakit CHALERMLARP, the Font Computer Program License Agreement reproduced in `sarabun-psk-LICENSE.txt`.

The document layout/embedding approach was studied from thai-doc-skills at commit `6aa488fa2ae1a00b7a9c38dd54feab4889b3fb5a` (MIT, copyright 2026 Netthip). The TypeScript implementation is independent and uses ICU segmentation. See the repository's existing third-party notice for the upstream MIT text. Font files have their own licenses, not the upstream code license.
