// Darwin Core Archive export for GBIF / OBIS.
// One occurrence per approved record (present), plus one "absent" occurrence of
// sharks and rays (Elasmobranchii) for each "nothing here" market check.
// The pure functions are unit-tested; downloadDwcA() packs them into a zip.
import { loadScript } from './util.js?v=14';

export const TERMS = [
  'occurrenceID', 'basisOfRecord', 'occurrenceStatus', 'eventID', 'eventDate', 'samplingProtocol', 'samplingEffort',
  'decimalLatitude', 'decimalLongitude', 'geodeticDatum', 'coordinateUncertaintyInMeters', 'georeferenceRemarks',
  'countryCode', 'locality', 'minimumDepthInMeters', 'maximumDepthInMeters', 'habitat',
  'scientificName', 'taxonRank', 'kingdom', 'phylum', 'class', 'family', 'vernacularName',
  'individualCount', 'sex', 'lifeStage', 'vitality', 'organismID',
  'identificationVerificationStatus', 'identifiedBy', 'dateIdentified', 'identificationRemarks',
  'associatedMedia', 'occurrenceRemarks', 'dynamicProperties', 'recordedBy', 'license', 'rightsHolder', 'datasetName', 'modified',
];
const NS = 'http://rs.tdwg.org/dwc/terms/';
const DC = new Set(['license', 'rightsHolder', 'modified']);
const termUri = t => (DC.has(t) ? 'http://purl.org/dc/terms/' : NS) + t;

const pad = n => String(n).padStart(2, '0');
// ISO 8601 local time with its UTC offset, e.g. 2026-11-23T10:15:00+04:00.
export function isoLocal(iso, offsetMin) {
  if (!iso) return '';
  const off = offsetMin ?? 0;
  const d = new Date(Date.parse(iso) + off * 60000);
  const sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const inSeychelles = (lat, lon) => lat > -11.5 && lat < -3 && lon > 45 && lon < 57;
const RANK = { Selachimorpha: 'superorder', Batoidea: 'superorder', Elasmobranchii: 'subclass' };
const SEX = { male: 'male', female: 'female', unknown: 'undetermined' };
const STAGE = { neonate: 'neonate', juvenile: 'juvenile', adult: 'adult' };
const PROTOCOL = {
  market: 'Opportunistic photo of an animal landed or for sale; species confirmed from the photo by a reviewer',
  in_water: 'Opportunistic photo of a live animal in the water; species confirmed from the photo by a reviewer',
  shallows: 'Opportunistic photo of a live animal in the shallows; species confirmed from the photo by a reviewer',
};
const VISIT_PROTOCOL = 'Market check: an observer checked a market or roadside seller for sharks and rays for sale';

export function occurrenceFromRecord(r, ds) {
  const scientificName = r.scientific_name?.replace(/\s+cf\.\s+/, ' ') || '';
  const dyn = {};
  if (r.length_cm) dyn.estimatedLengthCm = r.length_cm;
  if (r.measured_length_cm) { dyn.measuredLengthCm = r.measured_length_cm; dyn.lengthMeasure = r.measurement?.measure || r.size_measure; dyn.lengthMethod = `photo with ${r.measurement?.ref_kind || 'a'} reference, by ${r.measured_by || 'submitter'}`; }
  if (r.price != null) dyn.priceSCR = Number(r.price);
  if (r.context) dyn.context = r.context;
  return {
    occurrenceID: `urn:uuid:${r.id}`,
    basisOfRecord: 'HumanObservation',
    occurrenceStatus: 'present',
    eventID: r.visit_id ? `urn:uuid:${r.visit_id}` : '',
    eventDate: isoLocal(r.taken_at, r.local_offset_min),
    samplingProtocol: r.visit_id ? VISIT_PROTOCOL : (PROTOCOL[r.context] || PROTOCOL.market),
    samplingEffort: '',
    decimalLatitude: r.lat?.toFixed(5) ?? '', decimalLongitude: r.lon?.toFixed(5) ?? '',
    geodeticDatum: 'EPSG:4326',
    coordinateUncertaintyInMeters: r.location_accuracy_m ? Math.max(1, Math.round(r.location_accuracy_m)) : '',
    georeferenceRemarks: { live_gps: 'Phone GPS at the shutter', exif: 'GPS recorded in the photo', live_gps_at_upload: 'Phone GPS within 30 minutes of the photo' }[r.location_source] || '',
    countryCode: inSeychelles(r.lat, r.lon) ? 'SC' : '',
    locality: r.site_name || '',
    minimumDepthInMeters: r.depth_m ?? '', maximumDepthInMeters: r.depth_m ?? '',
    habitat: r.habitat || '',
    scientificName, taxonRank: RANK[scientificName] || 'species',
    kingdom: 'Animalia', phylum: 'Chordata', class: 'Chondrichthyes', family: r.family || '',
    vernacularName: r.common_name || '',
    individualCount: r.shark_count ?? 1,
    sex: r.sex_confirmed ? (SEX[r.sex] || '') : '',
    lifeStage: STAGE[r.life_stage] || '',
    vitality: r.context === 'market' ? 'dead' : r.context ? 'alive' : '',
    organismID: r.individual_code ? `${ds.homepage}individuals.html#${r.individual_code}` : '',
    identificationVerificationStatus: r.quality_grade === 'research'
      ? 'research grade: identification confirmed by an expert or a second reviewer'
      : 'verified: identification confirmed from the photo by one reviewer',
    identifiedBy: 'The Sharkive reviewers',
    dateIdentified: r.reviewed_at ? r.reviewed_at.slice(0, 10) : '',
    identificationRemarks: /\bcf\.\s/.test(r.scientific_name || '') ? `Provisional identification: ${r.scientific_name}` : '',
    associatedMedia: r.photo_url || '',
    occurrenceRemarks: r.notes ? r.notes.replace(/\s+/g, ' ').slice(0, 500) : '',
    dynamicProperties: Object.keys(dyn).length ? JSON.stringify(dyn) : '',
    recordedBy: 'The Sharkive contributor (anonymous)',
    license: ds.license, rightsHolder: ds.publisher, datasetName: ds.title,
    modified: (r.reviewed_at || r.taken_at || '').slice(0, 10),
  };
}

export function absenceFromVisit(v, ds) {
  return {
    occurrenceID: `urn:uuid:${v.id}:absent`,
    basisOfRecord: 'HumanObservation',
    occurrenceStatus: 'absent',
    eventID: `urn:uuid:${v.id}`,
    eventDate: v.ended_at && v.ended_at !== v.started_at
      ? `${isoLocal(v.started_at, v.local_offset_min)}/${isoLocal(v.ended_at, v.local_offset_min)}`
      : isoLocal(v.started_at, v.local_offset_min),
    samplingProtocol: VISIT_PROTOCOL,
    samplingEffort: v.duration_min ? `${v.duration_min} minutes` : 'one check',
    decimalLatitude: v.lat?.toFixed(5) ?? '', decimalLongitude: v.lon?.toFixed(5) ?? '',
    geodeticDatum: 'EPSG:4326',
    coordinateUncertaintyInMeters: v.location_accuracy_m ? Math.max(1, Math.round(v.location_accuracy_m)) : '',
    georeferenceRemarks: 'Phone GPS at the time of the check',
    countryCode: inSeychelles(v.lat, v.lon) ? 'SC' : '',
    locality: v.site_name || '',
    minimumDepthInMeters: '', maximumDepthInMeters: '', habitat: '',
    scientificName: 'Elasmobranchii', taxonRank: 'subclass', kingdom: 'Animalia', phylum: 'Chordata', class: 'Chondrichthyes',
    family: '', vernacularName: 'sharks and rays',
    individualCount: 0, sex: '', lifeStage: '', vitality: '', organismID: '',
    identificationVerificationStatus: '', identifiedBy: '', dateIdentified: '', identificationRemarks: '',
    associatedMedia: '',
    occurrenceRemarks: `No sharks or rays for sale at this ${v.kind === 'roadside' ? 'roadside seller' : 'market'}`,
    dynamicProperties: JSON.stringify({ visitKind: v.kind }),
    recordedBy: 'The Sharkive contributor (anonymous)',
    license: ds.license, rightsHolder: ds.publisher, datasetName: ds.title,
    modified: (v.ended_at || '').slice(0, 10),
  };
}

export function buildOccurrences(records, visits, ds) {
  const rows = records.map(r => occurrenceFromRecord(r, ds));
  for (const v of visits) if (!v.approved_sightings) rows.push(absenceFromVisit(v, ds));
  return rows;
}

const cell = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
export function toTsv(rows) {
  return [TERMS.join('\t'), ...rows.map(r => TERMS.map(t => cell(r[t])).join('\t'))].join('\n') + '\n';
}

export function metaXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://rs.tdwg.org/dwc/text/" metadata="eml.xml">
  <core encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="http://rs.tdwg.org/dwc/terms/Occurrence">
    <files><location>occurrence.txt</location></files>
    <id index="0"/>
${TERMS.map((t, i) => `    <field index="${i}" term="${termUri(t)}"/>`).join('\n')}
  </core>
</archive>
`;
}

const x = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
export function emlXml(ds, { records, absences, from, to }) {
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<eml:eml xmlns:eml="https://eml.ecoinformatics.org/eml-2.2.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="https://eml.ecoinformatics.org/eml-2.2.0 https://rs.gbif.org/schema/eml-gbif-profile/1.3/eml.xsd"
  packageId="the-sharkive-${today}" system="http://gbif.org" scope="system" xml:lang="en">
  <dataset>
    <title xml:lang="en">${x(ds.title)}</title>
    <creator><organizationName>${x(ds.publisher)}</organizationName>${ds.contact?.name ? `<individualName><surName>${x(ds.contact.name)}</surName></individualName>` : ''}${ds.contact?.email ? `<electronicMailAddress>${x(ds.contact.email)}</electronicMailAddress>` : ''}<onlineUrl>${x(ds.homepage)}</onlineUrl></creator>
    <pubDate>${today}</pubDate>
    <language>en</language>
    <abstract><para>Citizen-science photo records of sharks and rays in Seychelles: animals landed or for sale at markets and roadside sellers, and live animals seen in the water and the shallows. Every record has a photo with its capture time and GPS position taken from the photo or the phone, and its species was confirmed from the photo by a reviewer. Checks of markets and roadside sellers where no sharks or rays were for sale are included as absence records of Elasmobranchii. This export holds ${records} occurrence records and ${absences} absence records${from ? `, ${x(from)} to ${x(to)}` : ''}.</para></abstract>
    <intellectualRights><para>This work is licensed under a <ulink url="${x(ds.license)}"><citetitle>${x(ds.licenseName)}</citetitle></ulink>.</para></intellectualRights>
    <coverage>
      <geographicCoverage><geographicDescription>Seychelles</geographicDescription>
        <boundingCoordinates><westBoundingCoordinate>45</westBoundingCoordinate><eastBoundingCoordinate>57</eastBoundingCoordinate><northBoundingCoordinate>-3</northBoundingCoordinate><southBoundingCoordinate>-11.5</southBoundingCoordinate></boundingCoordinates>
      </geographicCoverage>
      <taxonomicCoverage><generalTaxonomicCoverage>Sharks and rays</generalTaxonomicCoverage><taxonomicClassification><taxonRankName>subclass</taxonRankName><taxonRankValue>Elasmobranchii</taxonRankValue></taxonomicClassification></taxonomicCoverage>
    </coverage>
    <contact><organizationName>${x(ds.publisher)}</organizationName>${ds.contact?.email ? `<electronicMailAddress>${x(ds.contact.email)}</electronicMailAddress>` : ''}</contact>
    <methods><methodStep><description><para>Contributors photograph each animal with the app. Time and position come from the photo's EXIF data or the phone's GPS at the shutter and cannot be edited. Species are suggested by on-device image matching and confirmed by a human reviewer; research-grade records were also confirmed by an expert or a second reviewer. At markets and roadside sellers, contributors also record checks where no sharks or rays were for sale.</para></description></methodStep></methods>
  </dataset>
</eml:eml>
`;
}

export async function downloadDwcA(records, visits, ds) {
  await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  const rows = buildOccurrences(records, visits, ds);
  const absences = rows.filter(r => r.occurrenceStatus === 'absent').length;
  const dates = records.map(r => r.taken_at).sort();
  const zip = new window.JSZip();
  zip.file('occurrence.txt', toTsv(rows));
  zip.file('meta.xml', metaXml());
  zip.file('eml.xml', emlXml(ds, { records: rows.length - absences, absences, from: dates[0]?.slice(0, 10), to: dates.at(-1)?.slice(0, 10) }));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sharkive-dwca-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  return { occurrences: rows.length - absences, absences };
}
