/**
 * Public organization facts used by the web document tools.
 *
 * Keep this copy aligned with the Harness organization manifest and registered
 * public profile. It is a source reference for drafting, not an authority
 * registry and not a replacement for a user-supplied different agency.
 */
export const STEP_ORGANIZATION = {
  nameTh: 'อุทยานวิทยาศาสตร์และเทคโนโลยี มหาวิทยาลัยเชียงใหม่',
  addressTh:
    'อาคาร A ชั้น 2 อาคารอำนวยการอุทยานวิทยาศาสตร์ภูมิภาค ภาคเหนือ (จังหวัดเชียงใหม่) 155 หมู่ 2 ตำบลแม่เหียะ อำเภอเมือง จังหวัดเชียงใหม่ 50100',
  sourceRef: 'step-contact',
  sourcePath: 'docs/knowledge/step-public-profile.md',
  lastChecked: '2026-09-20',
} as const;

export type OrganizationReference = {
  nameTh: string;
  addressTh: string;
  provenance: 'SOURCE_FACT';
  sourceRef: string;
  sourcePath: string;
  lastChecked: string;
};

export const stepOrganizationReference: OrganizationReference = {
  ...STEP_ORGANIZATION,
  provenance: 'SOURCE_FACT',
};
