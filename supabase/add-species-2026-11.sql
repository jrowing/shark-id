-- Adds 10 species found in the Seatizens (seatizens.sc) shark list.
-- Run once in Supabase → SQL Editor. Safe to re-run.
-- IUCN categories are approximate — check against the current Red List.
insert into public.species (id, common_name, scientific_name, family, iucn_status, max_length_cm, id_features) values
 ('blacktip','Blacktip shark','Carcharhinus limbatus','Carcharhinidae','VU',275,'Black tips on most fins (anal fin usually plain; fade in adults); moderately long pointed snout; pale band along the flank; no interdorsal ridge. Compare spinner shark.'),
 ('dusky','Dusky shark','Carcharhinus obscurus','Carcharhinidae','EN',420,'Large, slender; short broadly rounded snout; fairly low, slightly hooked first dorsal set over the pectoral rear tips; low interdorsal ridge; fins plain or dusky-tipped.'),
 ('bignose','Bignose shark','Carcharhinus altimus','Carcharhinidae','NT',300,'Long, broad rounded snout with prominent nasal flaps; tall first dorsal set over the pectoral bases; interdorsal ridge; plain grey fins with dusky tips. Deep-water; compare sandbar.'),
 ('pigeye','Pigeye (Java) shark','Carcharhinus amboinensis','Carcharhinidae','VU',280,'Very like the bull shark: heavy body, very short blunt snout, tiny eyes, no interdorsal ridge; first dorsal about three times the height of the second.'),
 ('humani-whaler','Human''s whaler shark','Carcharhinus cf. humani','Carcharhinidae','DD',90,'Small whaler shark (under about 1 m). Provisional ID (cf.) on Seatizens — confirm with an expert before approving records as this species.'),
 ('snaggletooth','Snaggletooth shark','Hemipristis elongata','Hemigaleidae','VU',240,'Long snout; hooked, serrated upper teeth and long lower teeth that stick out of the mouth even when closed; second dorsal about two-thirds the size of the first.'),
 ('sliteye','Sliteye shark','Loxodon macrorhinus','Carcharhinidae','NT',100,'Small, very slim shark; long narrow snout; large slit-like eyes with a notch at the rear; small second dorsal set behind the start of the anal fin.'),
 ('whale','Whale shark','Rhincodon typus','Rhincodontidae','EN',1800,'Enormous; very wide flat head with a terminal mouth; checkerboard of white spots and stripes on a dark back; ridges along the flanks.'),
 ('smooth-hammerhead','Smooth hammerhead','Sphyrna zygaena','Sphyrnidae','VU',500,'Hammer with a smoothly curved front edge and NO central notch; first dorsal moderately tall.'),
 ('roughskin-spurdog','Roughskin spurdog','Cirrhigaleus asper','Squalidae','DD',120,'Stout dogfish; a large spine in front of each dorsal fin; no anal fin; white margins on the fins; very rough skin; broadly rounded snout. Deep water.')
on conflict (id) do update set
  common_name = excluded.common_name, scientific_name = excluded.scientific_name, family = excluded.family,
  iucn_status = excluded.iucn_status, max_length_cm = excluded.max_length_cm, id_features = excluded.id_features;
