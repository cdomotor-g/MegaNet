// MegaNet — kb-lifecycle.js
//
//   KbLifecycle   🔁 the Site Lifecycle tab, in the Knowledge base group: how a
//                 hydrometric monitoring site is run from start to finish. The
//                 ten phases (selection and establishment, office prep, arrival
//                 and safety, initial checks, gauging, flood operations,
//                 departure, post-visit data, decommissioning, and a phase of
//                 tips) on a clickable drawing, each opening its actions and
//                 why they matter; a routine visit as a flowchart you walk one
//                 decision at a time; and the eight visit-priority scenarios
//                 as an exercise — sort each into one of four response
//                 priorities, then review the reasons. Adapted from Mallee
//                 HydroTech's Site Operations Lifecycle
//                 (github.com/MalleeHydroTech/site-operations-lifecycle):
//                 the phase cards, the routine-visit nodes and branches, the
//                 scenarios, buckets and feedback came across in the
//                 original's words, lightly condensed, with its "workplace
//                 dependent" flags kept. Its photographs were replaced by
//                 small drawings, and its React app, pan-and-zoom canvas,
//                 drag-and-drop and claim register were left out.
//
// After core.js (esc) and knowledge-base.js, before init.js. Reaches
// back to app.js for switchTab. Nothing runs at load.

const KbLifecycle = (function () {
  const TAB = 'kblifecycle';

  // ── The lifecycle ─────────────────────────────────────────────────────────
  // [id, number, title, short label, cards, Flood-Net tabs]. A card is
  // [title, what to do, why it matters, workplace dependent?] — the original's
  // wording. Authored here, not user input.
  const PHASES = [
    ['P1', 1, 'Site Selection & Establishment', 'Selection', [
      ['Check Hydraulic Control', 'Choose a representative reach with stable control. Check for braiding, backwater and features that may change.', 'Changes to the control can change the relationship between gauge height and discharge.', 0],
      ['Check Communications and Power', 'Check coverage, power demand and solar exposure before construction. Test communications under representative conditions.', 'The power and communications system must support the site\'s measurement and reporting needs.', 0],
      ['Confirm Access and Permission', 'Agree access, contacts and maintenance arrangements with the landowner. Check seasonal restrictions and safe ways in and out.', 'Reliable access lets the team maintain the site and respond when conditions change.', 0],
      ['Check Site Clearances', 'Request plans from Before You Dig Australia (BYDA) before digging. Confirm service locations and the land, heritage and environmental approvals needed.', 'Plans are a starting point. Site checks and local approvals help protect people, services and the environment.', 1],
    ], []],
    ['P2', 2, 'Office Prep & Monitoring', 'Preparation', [
      ['Define Purpose and Requirements', 'Agree what to measure, the required data quality, reporting times and who responds to problems.', 'The monitoring purpose sets the equipment, visit plan and urgency of a response.', 0],
      ['Review Data and Telemetry', 'Review incoming data on the planned schedule. Investigate gaps, spikes, noise and unexpected flat lines.', 'Early checks can reveal developing problems. An unusual trace needs investigation before you assign a cause.', 0],
      ['Compare Related Sites', 'Compare nearby or related records where useful. Consider rainfall, catchment response and local conditions.', 'Related records can help explain a change, but rarely identify its cause on their own.', 0],
      ['Set Visit Frequency', 'Set visits to suit site purpose, risk, equipment and data quality. Review the schedule after events or emerging problems.', 'A stable site and a changing site may need different attention.', 0],
    ], [['health', '📈 Station Health']]],
    ['P3', 3, 'Arrival & Safety Assessment', 'Arrival', [
      ['Complete Site Inductions', 'Complete required inductions and assess current hazards before work. Confirm controls, contacts and any changed conditions.', 'The team needs to know the site\'s hazards and the conditions of entry.', 1],
      ['Select Risk Controls', 'Apply the site\'s risk controls, including suitable protective equipment, communication, rescue arrangements and staffing.', 'Controls must suit the task and conditions, including moving water, heights and remote work.', 1],
      ['Control Minor Hazards', 'Deal with hazards within your training and authority. Report work that needs specialist help or a permit.', 'An attempted fix can create another hazard if it exceeds your skills or authority.', 1],
      ['Stop When Unsafe', 'Stop unsafe work. Notify the responsible person and record the hazard and next action.', 'Protecting people takes priority over collecting a measurement.', 0],
    ], []],
    ['P4', 4, 'Initial Checks & Maintenance', 'Initial checks', [
      ['Record Arrival Readings', 'Record reference and instrument readings before adjustment. Take them close together in time and note conditions and the applicable tolerance.', 'These readings preserve the site\'s original condition and provide a basis for later comparison.', 0],
      ['Investigate Differences', 'Check the reference, sensor, installation and data path. Keep the original readings, record authorised corrections and recheck. Escalate unresolved faults.', 'A difference may come from several parts of the system. Find the cause before changing a setting.', 0],
      ['Complete Planned Maintenance', 'Carry out authorised maintenance, such as clearing access or cleaning solar panels. Record the work and any remaining issues.', 'Routine care helps keep access, power and equipment reliable.', 1],
    ], [['inspections', '📋 Inspections'], ['maintenance', '🧰 Maintenance']]],
    ['P5', 5, 'Flow Measurement (Gauging)', 'Gauging', [
      ['Measure and Compare Flow', 'Gauge with a suitable method. Compare the result with the current rating, site conditions and measurement uncertainty.', 'Each gauging adds evidence about how well the rating represents the stream.', 0],
      ['Investigate Rating Change', 'Look for scour, sediment, debris or vegetation changes. Record evidence before recommending a rating change.', 'Physical changes can alter the discharge associated with a given gauge height.', 0],
      ['Repeat a Gauging When Needed', 'Repeat when the result needs checking. Where practical, use another section, instrument or operator to investigate the uncertainty.', 'An independent check can reveal a measurement or site effect that the first gauging missed.', 1],
      ['Record Site Evidence', 'Photograph and describe conditions relevant to the gauging, maintenance or rating decision. Record when and where you observed them.', 'A clear record lets others understand the conditions behind the result.', 0],
    ], []],
    ['P6', 6, 'Extreme Event / Flood Operations', 'Extreme event', [
      ['Use a Safe High-Flow Method', 'Work from a safe location using the flood plan. Stop and escalate when conditions exceed the planned controls.', 'Flood conditions can change quickly. A measurement is never a reason to continue unsafe work.', 1],
      ['Plan High-Flow Measurement', 'Plan safe measurements across the upper rating range. Use suitable alternative evidence when direct gauging is unsafe or unavailable.', 'High-flow evidence helps reduce uncertainty where few gaugings are available.', 1],
      ['Keep the Operator Out of the Water', 'Consider a bank-operated ADCP or non-contact radar or camera method. Choose an approach suited to the site and safety plan.', 'An ADCP enters the water even when its operator stays on the bank. Radar and cameras sense surface movement remotely.', 0],
      ['Check Intake Response', 'Check relevant intakes and stilling wells for sediment, blockage or slow response. Compare with independent water-level observations.', 'Restricted flow into a well can delay its response and affect the recorded peak.', 0],
    ], []],
    ['P7', 7, 'Departure', 'Departure', [
      ['Record Departure Readings', 'Repeat the required reference checks before departure. Record final readings, equipment condition and unresolved issues.', 'The final check shows what changed during the visit and what needs follow-up.', 0],
      ['Secure the Site', 'Secure equipment, gates and barriers. Check the site\'s livestock and pest controls and record the condition left.', 'Suitable security helps protect people, equipment and the monitoring record.', 1],
    ], [['inspections', '📋 Inspections']]],
    ['P8', 8, 'Post-Visit Data Management', 'Post-visit', [
      ['File Visit Records', 'File field notes, photographs and site history in the workplace record system.', 'Good records help the next hydrographer understand the site and earlier decisions.', 0],
      ['Review Data Quality', 'Check the data against field observations. Apply appropriate quality codes and retain unedited primary data alongside processed records.', 'Keeping the original data and a record of changes makes the result traceable.', 0],
      ['Review the Rating', 'Review the rating when gaugings or site evidence suggest change. Record the reason and obtain the required approval before release.', 'A rating needs evidence for the conditions and range in which it is used.', 0],
    ], []],
    ['P9', 9, 'End of Life / Decommissioning', 'Decommissioning', [
      ['Decide When to Retire a Site', 'Review closure when purpose, safety, access or physical conditions change. Agree whether a replacement site or continued record is needed.', 'Retirement affects the monitoring network and the people who use its data.', 0],
      ['Remove and Restore', 'Remove equipment and restore the site under the agreed safety, asset, waste and stakeholder requirements.', 'Planned removal and restoration help avoid leaving hazards or damage.', 1],
      ['Check Closure Requirements', 'Confirm the land, waterway, environmental and cultural heritage requirements for the location and proposed work.', 'The permissions needed depend on what is being done and where.', 1],
      ['Close and Archive the Dataset', 'Archive the data and closure records, including final condition, reference information and photographs required by the closure plan.', 'A complete archive preserves the site\'s history after the equipment is gone.', 0],
    ], []],
    ['P10', 10, 'Tips and Tricks', 'Tips and tricks', [
      ['Review Before Adjusting', 'If readings are within tolerance, leave the setting alone. Investigate the trend and cause before making an authorised adjustment.', 'Unnecessary adjustments can hide a developing problem and make the record harder to interpret.', 0],
      ['Compare Gauge and Sensor Locations', 'Record where the staff gauge and sensor, intake or orifice measure level. Check the reference relationship before adjusting for a difference.', 'Water-surface slope or intake effects can produce different readings. Do not force agreement by changing calibration.', 1],
      ['Record Time and Context', 'Check photograph timestamps and record the location and conditions needed to interpret each observation.', 'Accurate context lets you match the observation to the site record.', 1],
      ['Record Reading Uncertainty', 'Record how confidently you could read the gauge. Note waves, surging or other conditions and the basis of your uncertainty estimate.', 'An uncertainty estimate helps others judge how much weight to give the reading.', 1],
      ['Check the Measurement Chain', 'Check the reference, sensor position and reported gauge height. Look for movement before applying a correction.', 'A moved sensor or reference can look like a change in water level.', 0],
      ['Record Site Changes', 'Take wide photographs and notes of changes to the channel, control or installation. Compare with earlier records.', 'Site history helps explain differences between gaugings and the rating.', 0],
      ['Make a Field Estimate', 'Before gauging, make a quick mental estimate of discharge. Compare it with the measured result and think about what you missed.', 'Repeated comparisons help you develop a feel for flow. Your estimate may also guide method choice or prompt a useful check.', 1],
      ['Choose a Useful Check Gauging', 'Decide what needs checking. Where practical, vary the section, instrument or operator so the repeat gauging tests that question.', 'Repeating the same approach may also repeat the same source of error.', 1],
      ['Record Before Cleaning the Control', 'Record the control and water level before cleaning. Recheck afterwards and describe what changed.', 'Removing debris or vegetation can change the control and its effect on water level.', 1],
      ['Match Sensor Location to Purpose', 'Choose a representative location for the variable being measured. Follow the installation method for level or water-quality monitoring.', 'A good location for one measurement may be unsuitable for another.', 1],
      ['Check Water-Quality Instruments', 'Use a suitable, calibrated reference for comparison. Record conditions and follow the method for cleaning, calibration or replacement.', 'The reference and comparison method determine whether a difference is meaningful.', 1],
      ['Clean Instruments Safely', 'Follow the manufacturer\'s cleaning method and protect sensing surfaces. Use pest treatments only under the site\'s safety and environmental controls.', 'Even a soft brush can damage an exposed pressure diaphragm or another sensitive component.', 1],
      ['Check Clocks and Time Zone', 'Align instrument clocks with field records. Document the time zone and the system\'s daylight-saving convention.', 'A time mismatch can put an observation against the wrong part of the data trace.', 1],
      ['Record River Trend', 'Note whether the river is rising, falling or steady, including changes during the gauging.', 'Changing stage matters when matching a gauging to its representative gauge height.', 0],
      ['Check Independent Benchmarks', 'Check the site\'s independent benchmarks and reference IDs using the required survey method. Record any movement.', 'Independent stable marks help distinguish gauge movement from movement of a reference mark.', 0],
      ['Check Power Under Load', 'Check battery and charging performance under the expected load, using the manufacturer\'s test method and limits.', 'A single unloaded voltage reading gives an incomplete picture of the power system.', 1],
      ['Check Vents and Desiccant', 'On vented instruments, check for blocked or kinked vent tubes and spent desiccant. Follow the manufacturer\'s replacement instructions.', 'The vent supplies the pressure reference. Moisture and obstructions can affect readings or damage equipment.', 0],
      ['Record Safe Site Observations', 'Note visible changes and any odour noticed from a safe position. Never deliberately inhale vapour or smell a sample.', 'Observations add context. They do not replace water-quality measurements.', 1],
    ], [['levels', '📏 Level Survey'], ['surveyguide', '📖 How to Survey']]],
  ];

  // Where each phase sits on the drawing (viewBox 560 × 240): row one runs
  // left to right, row two comes back, and Tips stands to one side.
  const LIFE_POS = { P1: [60, 64], P2: [170, 64], P3: [280, 64], P4: [390, 64], P5: [500, 64],
    P6: [500, 172], P7: [390, 172], P8: [280, 172], P9: [170, 172], P10: [60, 172] };

  // ── The routine visit ─────────────────────────────────────────────────────
  // [id, kind, label on the drawing ('|' breaks a line), title, what happens,
  //  workplace dependent?]. Kinds: start, process, decision, stop, end, note.
  const NODES = [
    ['N01', 'start', 'Review|before travel', 'Review before travel', 'Check current data, known issues, visit purpose and client requirements. Confirm the approved visit frequency and expected conditions.', 0],
    ['N02', 'process', 'Start the|visit safely', 'Start the visit safely', 'Park and enter the site safely, complete the required induction and current risk assessment, and put the approved controls in place.', 1],
    ['N03', 'decision', 'Safe to|work?', 'Can the work be done safely?', 'Decide whether the assessed risk can be controlled under the approved method and your authority and competence.', 0],
    ['N04', 'stop', 'Stop, record|and escalate', 'Stop, record and escalate', 'If the risk is not manageable, stop the work, record the reason and follow the approved incident, return or escalation process.', 0],
    ['N05', 'process', 'Arrival|readings', 'Record arrival readings', 'Take the reference and instrument readings as close in time as the method requires. Record time, conditions and the applicable acceptance criterion.', 0],
    ['N06', 'decision', 'Within|criterion?', 'Is the comparison within the approved criterion?', 'Compare the readings using the controlled tolerance or acceptance criterion for the site and purpose.', 0],
    ['N07', 'process', 'Investigate|and recheck', 'Investigate and recheck', 'Check the reference, sensor, installation and data path. Keep the original readings, record authorised corrections and recheck. Escalate unresolved faults.', 0],
    ['N08', 'process', 'Flow|measurement', 'Complete a flow measurement', 'Use a suitable method and instrument, then compare the result with the applicable rating, conditions and uncertainty.', 0],
    ['N09', 'decision', 'Gauging|accepted?', 'Does the gauging need further investigation?', 'Assess the result against the applicable rating, physical conditions and accepted uncertainty before choosing the next step.', 0],
    ['N10', 'process', 'Repeat|gauging', 'Repeat a gauging when needed', 'Repeat a gauging when the evidence or work plan requires it. Where practical, use a different section, instrument or operator to test the defined uncertainty. Record the method and conditions.', 1],
    ['N11', 'process', 'Photos and|metadata', 'Record photos and metadata', 'Capture the site condition, method and context needed for the measurement, safety, maintenance or rating decision.', 0],
    ['N12', 'process', 'Control before|and after', 'Record the control before and after cleaning', 'Where cleaning may change the measured condition, record the state before and after work using the approved method.', 1],
    ['N13', 'process', 'Planned|maintenance', 'Complete planned site maintenance', 'Carry out authorised maintenance for the site and equipment, and record what was done, why and under which procedure.', 1],
    ['N14', 'process', 'Departure|readings', 'Record departure readings', 'Complete the departure reference check required by the work plan. Record final readings, condition, outstanding issues and any acceptance result.', 0],
    ['N15', 'decision', 'Within|criterion?', 'Does the final check meet the approved criterion?', 'Assess the final readings against the controlled tolerance or acceptance criterion.', 0],
    ['N16', 'process', 'Correct|and recheck', 'Correct and recheck', 'Keep the departure record. Apply an authorised correction only when the evidence and plan support it, then take a separate repeat check. Escalate or stop if the condition remains unresolved.', 0],
    ['N17', 'process', 'Secure|the site', 'Secure the site', 'Apply the approved locks, barriers, pest or livestock controls and final condition check. Record the state left at the site.', 0],
    ['N18', 'end', 'Post-visit|record', 'Complete the post-visit record', 'File the notes, photographs and metadata, complete the required data-quality review and quality coding, and refer any rating change through the approved authority.', 0],
    ['N19', 'note', 'Extreme events: check references|before adjusting', 'Check references during extreme events', 'Record the staff gauge and sensor or intake locations. Check datum and hydraulic effects before adjusting. Use independent site references to investigate movement.', 0],
  ];

  // [from, to, caption on the drawing (decisions only), the choice in words,
  //  route on the drawing: 'Nxx:side' anchors and [x, y] corners].
  const EDGES = [
    ['N01', 'N02', '', 'After preparation, travel to the site', ['N01:r', 'N02:l']],
    ['N02', 'N03', '', 'On arrival, assess the current risk', ['N02:r', 'N03:l']],
    ['N03', 'N04', 'Not safe', 'If the risk is not manageable, stop and record the reason', ['N03:b', 'N04:t']],
    ['N03', 'N05', 'Safe', 'If the risk is manageable under the plan, take the arrival readings', ['N03:r', 'N05:l']],
    ['N05', 'N06', '', 'Assess the arrival comparison', ['N05:r', 'N06:l']],
    ['N06', 'N07', 'Outside', 'If the readings are outside the criterion, investigate', ['N06:b', 'N07:t']],
    ['N07', 'N05', 'Repeat', 'After a corrective action, take a separate repeat check and retain the arrival record', ['N07:l', [406, 125], 'N05:b']],
    ['N06', 'N08', 'Within', 'If the comparison is acceptable, gauge when the work plan requires it', ['N06:r', 'N08:l']],
    ['N08', 'N09', '', 'Assess the gauging against the applicable rating', ['N08:b', 'N09:t']],
    ['N09', 'N10', 'Needs evidence', 'If a check gauging is needed, use a suitable alternative', ['N09:b', 'N10:t']],
    ['N09', 'N11', 'Accepted', 'If the result is accepted for the plan, record the evidence', ['N09:l', 'N11:r']],
    ['N10', 'N11', '', 'After a check gauging, record the method and evidence', ['N10:l', [522, 300], 'N11:b']],
    ['N11', 'N12', '', 'After the evidence review, clean only if required', ['N11:l', 'N12:r']],
    ['N12', 'N13', '', 'After approved cleaning, complete other required maintenance', ['N12:l', 'N13:r']],
    ['N13', 'N14', '', 'After planned work, take the departure readings', ['N13:l', 'N14:r']],
    ['N14', 'N15', '', 'Assess the departure comparison', ['N14:l', 'N15:r']],
    ['N15', 'N16', 'Outside', 'If the departure result is outside the criterion, correct or escalate', ['N15:t', 'N16:b']],
    ['N16', 'N14', 'Repeat', 'After correction, take a separate repeat departure check', ['N16:r', [174, 125], 'N14:t']],
    ['N15', 'N17', 'Within', 'If the departure result is accepted, secure the site', ['N15:b', 'N17:t']],
    ['N17', 'N18', '', 'After securing the site, complete the post-visit record', ['N17:r', 'N18:l']],
  ];

  // Node centres and sizes on the flowchart (viewBox 700 × 345).
  const COL = [58, 174, 290, 406, 522, 638];
  const ROW = { a: 45, b: 125, c: 215, d: 300 };
  const FLOW_POS = {
    N01: [0, 'a'], N02: [1, 'a'], N03: [2, 'a'], N05: [3, 'a'], N06: [4, 'a'], N08: [5, 'a'],
    N04: [2, 'b'], N07: [4, 'b'], N16: [0, 'b'],
    N09: [5, 'c'], N11: [4, 'c'], N12: [3, 'c'], N13: [2, 'c'], N14: [1, 'c'], N15: [0, 'c'],
    N10: [5, 'd'], N17: [0, 'd'], N18: [1, 'd'],
  };

  // ── Visit priority ────────────────────────────────────────────────────────
  // [id, label, the bucket's test, what it means].
  const BUCKETS = [
    ['visit-first', 'Urgent response', 'Respond or escalate first. Enter only when safe and approved.',
      'This scenario has an immediate service or safety consequence. Respond or escalate first. Enter the site only when the approved plan and current controls make it safe.'],
    ['high-priority', 'High priority', 'Primary record unreliable with no verified backup.',
      'This scenario has an unreliable primary record and no verified backup. Follow the escalation and response procedure.'],
    ['planned-priority', 'Planned priority', 'Verified backup preserves continuity and delay is accepted.',
      'The stated backup preserves the required continuity and the client accepts delayed action. Verify those assumptions.'],
    ['lower-immediate', 'Lower immediate priority', 'No immediate safety, security or data consequence remains.',
      'The stated checks remove an immediate safety, security and data consequence. Schedule the work under the approved plan.'],
  ];

  // [id, drawing, title, summary, the situation, the context, suggested bucket,
  //  the reason shown when a placement does not match].
  const SCENARIOS = [
    ['T01', 'flood_warning', 'Protect the Flood Warning Service',
      'Verified power problem, flood-warning service, forecast rain and no working backup.',
      'A verified power problem affects the flood-warning service. Heavy rain is forecast in the upper catchment. The site has no working backup.',
      'Respond or escalate under the service and emergency plan. Check safe access, the power evidence and the response arrangement before any site entry.',
      'visit-first',
      'Urgent response: the flood-warning service has a verified power problem, forecast rain and no working backup. Respond or escalate under the approved plan. Enter only when safe.'],
    ['T02', 'warragamba', 'Restore Critical Dam Telemetry',
      'Dam inflow telemetry stopped; current data needed for spillway decisions, with no suitable alternative.',
      'Dam inflow telemetry stopped after a storm. The operator needs current data for spillway decisions and has no suitable alternative.',
      'Confirm the data consequence and escalation path. Enter only under the approved safe response plan.',
      'visit-first',
      'Urgent response: current dam inflow data is needed for spillway decisions and no suitable alternative is available. Confirm the escalation and safe response plan before entry.'],
    ['T03', 'hs40', 'Investigate Possible Bubbler Failure',
      'Primary level record unreliable, no verified backup; cause needs investigation.',
      'The primary level record is unreliable and no verified backup is available. Investigate possible leak, blockage, power or sensor causes. The cause is not confirmed.',
      'Check local records, physical evidence, the instrument procedure and safe access before choosing the response.',
      'high-priority',
      'High priority: the primary level record is unreliable and no verified backup is available. Investigate leak, blockage, power and sensor causes rather than assuming one cause.'],
    ['T04', 'exo', 'Investigate the Dissolved Oxygen Reading',
      'Zero dissolved oxygen may be real or a sensor problem; no verified backup.',
      'The dissolved oxygen reading is zero while other water-quality readings are stable. The result may reflect very low oxygen or a sensor problem. No verified backup is available.',
      'Verify the result with the approved water-quality method and escalate under the compliance and client response plan. Treat the cause as unresolved.',
      'high-priority',
      'High priority: the zero dissolved oxygen result may be real or a sensor problem, and no verified backup is available. Verify and escalate under the water-quality plan.'],
    ['T05', 'tbrg', 'Check Missing Rainfall',
      'Nearby rainfall confirmed, gauge stays at zero; rainfall backup verified and repair accepted.',
      'Rainfall is confirmed nearby, but the tipping-bucket gauge stays at zero. A suitable independent rainfall backup is verified for the required purpose, and the client accepts planned repair. A level sensor does not replace rainfall data.',
      'Check the rainfall record, backup scope, safe access and repair plan. Keep the issue with the planned response unless the stated assumptions change.',
      'planned-priority',
      'Planned priority: nearby rainfall is confirmed, the gauge stays at zero, an independent rainfall backup is verified for the required purpose and the client accepts planned repair. Level data does not replace rainfall data.'],
    ['T06', 'logger', 'Recover Data from the Local Logger',
      'Timestamped local records verified intact and recoverable; delayed delivery accepted.',
      'A local logger has timestamped records that have been verified as intact and recoverable. Transport is delayed, and the client accepts the delay.',
      'Recover the records under the approved plan and confirm the delivery window and data-quality review.',
      'planned-priority',
      'Planned priority: timestamped local records are verified intact and recoverable, and delayed delivery is accepted. Recover them under the approved plan.'],
    ['T07', 'aws', 'Repair the Site Fence',
      'Checks confirm no livestock, public or security exposure; equipment and data unaffected.',
      'A branch has damaged the fence. Risk checks confirm no livestock, public or security exposure, and the equipment and data are unaffected.',
      'Schedule the repair under the approved plan and review the risk if site conditions change.',
      'lower-immediate',
      'Lower immediate priority: risk checks show no livestock, public or security exposure, and the equipment and data are unaffected. Schedule the repair under the approved plan.'],
    ['T08', 'encoder', 'Review Secondary Sensor Drift',
      'Secondary drift within tolerance; primary independently checked; no immediate backup need.',
      'The secondary sensor drift remains within documented tolerance. The primary sensor has been independently checked, and no immediate backup is needed. A worsening trend triggers review.',
      'Verify the tolerance, primary check, trend and procedure before scheduling review.',
      'lower-immediate',
      'Lower immediate priority: secondary drift is within documented tolerance, the primary sensor has been independently checked and no immediate backup is needed. Review if the trend worsens.'],
  ];

  const FB = {
    incomplete: 'Place all eight scenarios before reviewing the reasons for the suggested categories.',
    review: 'Review the reason for each placement. The guide uses the stated service, backup, safety, security and data conditions; these are workplace-dependent examples.',
    retry: 'Review the highlighted placements and the reasons on their cards. Adjust a placement if needed.',
    match: 'Matches the suggested bucket.',
  };

  // The original's reference list, trimmed to the published sources.
  const REFS = [
    ['BoM National Industry Guidelines Part 2 — Site Establishment and Operations', 'Bureau of Meteorology', 'https://www.bom.gov.au/sites/default/files/2023-01/national-industry-guidelines-hydrometric-monitoring-part-2.pdf'],
    ['BoM National Industry Guidelines Part 3 — Instrument and Measurement Systems Management', 'Bureau of Meteorology', 'https://www.bom.gov.au/sites/default/files/2023-01/national-industry-guidelines-hydrometric-monitoring-part-3.pdf'],
    ['BoM National Industry Guidelines Part 4 — Gauging (stationary velocity-area method)', 'Bureau of Meteorology', 'https://www.bom.gov.au/sites/default/files/2023-01/national-industry-guidelines-hydrometric-monitoring-part-4.pdf'],
    ['BoM National Industry Guidelines Part 5 — Data Editing, Estimation and Management', 'Bureau of Meteorology', 'https://www.bom.gov.au/sites/default/files/2023-01/national-industry-guidelines-hydrometric-monitoring-part-5.pdf'],
    ['BoM National Industry Guidelines Part 6 — Stream Discharge Relationship Development and Maintenance', 'Bureau of Meteorology', 'https://www.bom.gov.au/sites/default/files/2023-01/national-industry-guidelines-hydrometric-monitoring-part-6.pdf'],
    ['BoM National Industry Guidelines Part 8 — ADCPs', 'Bureau of Meteorology', 'https://www.bom.gov.au/sites/default/files/2023-01/national-industry-guidelines-hydrometric-monitoring-part-8.pdf'],
    ['NWPHYD008 Operate, maintain and decommission monitoring sites', 'training.gov.au', 'https://training.gov.au/TrainingComponentFiles/NWP/NWPHYD008_R1.pdf'],
    ['Remote or isolated work', 'Safe Work Australia', 'https://www.safeworkaustralia.gov.au/safety-topic/managing-health-and-safety/mental-health/psychosocial-hazards/remote-or-isolated-work'],
    ['How we measure streamflow', 'Victorian Water Measurement Information System', 'https://data.water.vic.gov.au/how-we-measure-streamflow'],
    ['Authorising works and activities on waterways', 'Victorian Government', 'https://www.water.vic.gov.au/waterways/authorising-works-and-activities-on-waterways'],
    ['Waterway barriers and fish passage', 'Queensland Government', 'https://www.business.qld.gov.au/industries/farms-fishing-forestry/fisheries/development/waterways/barriers'],
    ['Before You Dig Australia (BYDA)', 'Before You Dig Australia', 'https://www.byda.com.au/about/'],
    ['Image velocimetry earns its place in the WMO Guide to Hydrological Practice', 'World Meteorological Organization', 'https://wmo.int/media/announcement/image-velocimetry-earns-its-place-wmo-guide-hydrological-practice'],
    ['Hydrology publications catalogue', 'World Meteorological Organization', 'https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/water-resources-assessment/hydrology-publications'],
    ['Hydrometric Levelling 2023', 'Water Survey of Canada', 'https://publications.gc.ca/collections/collection_2023/eccc/En37-465-2023-eng.pdf'],
    ['Dissolved Oxygen v3.0.0', 'National Environmental Monitoring Standards (NZ)', 'https://nems-prod.syd1.digitaloceanspaces.com/public/Documents/Dissolved-Oxygen-v3.0.0.pdf'],
    ['Aqua TROLL 100/200 Manual', 'In-Situ', 'https://in-situ.com/pub/media/support/documents/Aqua_TROLL_100-200_Manual.pdf'],
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let phase = 'P1';
  let trail = ['N01'];
  let order = null;
  let picks = {};
  let reviewed = false;

  const phaseOf = id => PHASES.find(p => p[0] === id) || PHASES[0];
  const nodeOf = id => NODES.find(n => n[0] === id);
  const bucketOf = id => BUCKETS.find(b => b[0] === id);
  const WD_TAG = '<span class="kc-wd" title="Depends on your organisation, client, equipment, jurisdiction or approved procedure">Your workplace\'s call</span>';

  function shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ── The lifecycle drawing ─────────────────────────────────────────────────
  function lifeSvg() {
    const cur = phaseOf(phase);
    const arrow = (x1, y1, x2, y2) => `<line class="kc-link" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#kc-arrow-l)"/>`;
    const links = [
      arrow(84, 64, 144, 64), arrow(194, 64, 254, 64), arrow(304, 64, 364, 64), arrow(414, 64, 474, 64),
      arrow(500, 88, 500, 146),
      arrow(476, 172, 416, 172), arrow(366, 172, 306, 172), arrow(256, 172, 196, 172),
    ].join('');
    const loop = `<path class="kc-link kc-loop" d="M262 154 C 240 122, 196 116, 178 90" marker-end="url(#kc-arrow-l)"/>
      <text class="kc-cap" x="236" y="118" text-anchor="middle">next visit</text>`;
    const nodes = PHASES.map(([id, n, title, short]) => {
      const [x, y] = LIFE_POS[id];
      const on = id === phase ? ' kc-on' : '';
      const ly = y < 100 ? y - 32 : y + 40;
      const shape = id === 'P10'
        ? `<rect class="kc-node kc-tips${on}" x="${x - 26}" y="${y - 22}" width="52" height="44" rx="8"/>`
        : `<circle class="kc-node${on}" cx="${x}" cy="${y}" r="22"/>`;
      return `<g class="kc-hit" data-phase="${id}">${shape}
        <text class="kc-num${on}" x="${x}" y="${y + 5}" text-anchor="middle">${n}</text>
        <text class="kc-lab${on}" x="${x}" y="${ly}" text-anchor="middle">${esc(short)}</text></g>`;
    }).join('');
    const name = `The site lifecycle: ten phases from site selection to decommissioning, with a loop from post-visit data back to office prep for the next visit, and tips that apply at any phase. Phase ${cur[1]}, ${cur[2]}, is selected.`;
    return `<svg class="kc-svg kc-life-svg" viewBox="0 0 560 240" role="img" aria-label="${esc(name)}">
      <title>${esc(name)}</title>
      <defs><marker id="kc-arrow-l" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kc-arrowhead" d="M0 0 L10 5 L0 10 z"/></marker></defs>
      ${links}${loop}
      <text class="kc-cap" x="60" y="226" text-anchor="middle">any phase</text>
      ${nodes}</svg>`;
  }

  function phaseButtons() {
    return PHASES.map(([id, n, title, short]) =>
      `<button type="button" class="kc-chip" data-phase="${id}" aria-pressed="${id === phase}" title="${esc(title)}"
        onclick="KbLifecycle.phase('${id}')"><span class="kc-chip-n">${n}</span> ${esc(short)}</button>`).join('');
  }

  function phaseDetail() {
    const [id, n, title, , cards, tabs] = phaseOf(phase);
    const i = PHASES.findIndex(p => p[0] === id);
    const prev = PHASES[i - 1], next = PHASES[i + 1];
    return `<h4 id="kc-phase-h" tabindex="-1">${n}. ${esc(title)}</h4>
      <ul class="kc-cards">${cards.map(([t, copy, why, wd]) => `<li>
        <p class="kc-card-t"><strong>${esc(t)}</strong>${wd ? ' ' + WD_TAG : ''}</p>
        <p>${esc(copy)}</p>
        <p class="small kc-why"><span class="kc-why-k">Why it matters:</span> ${esc(why)}</p></li>`).join('')}</ul>
      ${tabs.length ? `<p class="small">In Flood-Net: ${tabs.map(([tab, label]) =>
        `<button type="button" class="link-btn" onclick="switchTab('${tab}')">${esc(label)}</button>`).join(' · ')}</p>` : ''}
      <div class="button-row">
        ${prev ? `<button type="button" onclick="KbLifecycle.phase('${prev[0]}', true)">← ${esc(prev[3])}</button>` : '<span></span>'}
        ${next ? `<button type="button" onclick="KbLifecycle.phase('${next[0]}', true)">${esc(next[3])} →</button>` : ''}
      </div>`;
  }

  // ── The routine-visit flowchart ───────────────────────────────────────────
  function geom(id) {
    if (id === 'N19') return { x: 360, y: 300, hw: 120, hh: 22 };
    const [c, r] = FLOW_POS[id];
    const kind = nodeOf(id)[1];
    return kind === 'decision' ? { x: COL[c], y: ROW[r], hw: 46, hh: 29 } : { x: COL[c], y: ROW[r], hw: 44, hh: 20 };
  }
  function anchor(spec) {
    if (Array.isArray(spec)) return spec;
    const [id, side] = spec.split(':');
    const g = geom(id);
    return side === 'l' ? [g.x - g.hw, g.y] : side === 'r' ? [g.x + g.hw, g.y]
      : side === 't' ? [g.x, g.y - g.hh] : [g.x, g.y + g.hh];
  }
  function shape(kind, g, cls) {
    const { x, y, hw, hh } = g;
    if (kind === 'decision') return `<polygon class="${cls}" points="${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}"/>`;
    if (kind === 'start' || kind === 'end') return `<ellipse class="${cls}" cx="${x}" cy="${y}" rx="${hw}" ry="${hh}"/>`;
    if (kind === 'stop') {
      const c = 8;
      return `<polygon class="${cls} kc-stop" points="${x - hw + c},${y - hh} ${x + hw - c},${y - hh} ${x + hw},${y - hh + c} ${x + hw},${y + hh - c} ${x + hw - c},${y + hh} ${x - hw + c},${y + hh} ${x - hw},${y + hh - c} ${x - hw},${y - hh + c}"/>`;
    }
    return `<rect class="${cls}${kind === 'note' ? ' kc-note' : ''}" x="${x - hw}" y="${y - hh}" width="${hw * 2}" height="${hh * 2}" rx="6"/>`;
  }

  function flowSvg() {
    const cur = trail[trail.length - 1];
    const seen = new Set(trail);
    const walked = new Set();
    for (let i = 1; i < trail.length; i++) walked.add(trail[i - 1] + '>' + trail[i]);
    const caps = [];   // drawn after the shapes, so no node covers a caption
    const edges = EDGES.map(([from, to, cap, , route]) => {
      const pts = route.map(anchor);
      const on = walked.has(from + '>' + to) ? ' kc-walked' : '';
      let label = '';
      if (cap) {
        const [a, b] = [pts[0], pts[1]];
        const vertical = a[0] === b[0];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        label = vertical
          ? `<text class="kc-cap" x="${cap === 'Needs evidence' ? mx - 6 : mx + 6}" y="${my + 4}" text-anchor="${cap === 'Needs evidence' ? 'end' : 'start'}">${esc(cap)}</text>`
          : `<text class="kc-cap" x="${mx}" y="${my - 7}" text-anchor="middle">${esc(cap)}</text>`;
      }
      caps.push(label);
      return `<polyline class="kc-link${on}" points="${pts.map(p => p.join(',')).join(' ')}" marker-end="url(#kc-arrow-f)"/>`;
    }).join('');
    const nodes = NODES.map(([id, kind, label]) => {
      const g = geom(id);
      const cls = 'kc-node' + (id === cur ? ' kc-on' : seen.has(id) ? ' kc-seen' : '');
      const lines = label.split('|');
      const y0 = g.y - (lines.length - 1) * 6.5 + 4;
      return `<g class="kc-hit" data-node="${id}">${shape(kind, g, cls)}${lines.map((l, i) =>
        `<text class="kc-flab${id === cur ? ' kc-on' : ''}" x="${g.x}" y="${y0 + i * 13}" text-anchor="middle">${esc(l)}</text>`).join('')}</g>`;
    }).join('');
    const n = nodeOf(cur);
    const name = `Routine visit flowchart: 18 steps and 4 decisions, from reviewing before travel to the post-visit record, with a stop branch when the work is unsafe and repeat-check loops at arrival and departure. You are at: ${n[3]}.`;
    return `<svg class="kc-svg kc-flow-svg" viewBox="0 0 700 345" role="img" aria-label="${esc(name)}">
      <title>${esc(name)}</title>
      <defs><marker id="kc-arrow-f" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kc-arrowhead" d="M0 0 L10 5 L0 10 z"/></marker></defs>
      ${edges}${nodes}${caps.join('')}</svg>`;
  }

  const KIND = { start: 'Start', process: 'Step', decision: 'Decision', stop: 'Stop', end: 'Finish', note: 'Note' };

  function flowStep() {
    const cur = trail[trail.length - 1];
    const [id, kind, , title, copy, wd] = nodeOf(cur);
    const out = EDGES.filter(e => e[0] === id);
    const n = NODES.findIndex(x => x[0] === id) + 1;
    let next;
    if (out.length) {
      next = `<p class="kc-ask">${kind === 'decision' ? 'Which way does it go?' : 'Next:'}</p>
        <div class="kc-choices">${out.map(([, to, , label]) =>
          `<button type="button" class="${kind === 'decision' ? '' : 'primary'}" onclick="KbLifecycle.go('${to}')">${esc(label)}</button>`).join('')}</div>`;
    } else if (kind === 'stop') {
      next = '<p class="kc-ask">The visit ends here: nothing more is done on site until the risk is resolved.</p>';
    } else if (kind === 'end') {
      next = '<p class="kc-ask">That is the routine visit, start to finish.</p>';
    } else {
      next = '<p class="kc-ask">This applies whenever there is an extreme event — it sits beside the flow, not in it.</p>';
    }
    return `<p class="kc-kind kc-kind-${kind}">${KIND[kind]} · ${n} of ${NODES.length}</p>
      <h4 id="kc-step-h" tabindex="-1">${esc(title)}${wd ? ' ' + WD_TAG : ''}</h4>
      <p>${esc(copy)}</p>
      ${next}
      <div class="button-row">
        ${trail.length > 1 ? '<button type="button" onclick="KbLifecycle.back()">← Back a step</button>' : '<span></span>'}
        ${trail.length > 1 ? '<button type="button" onclick="KbLifecycle.go(\'N01\', true)">↺ Start again</button>' : ''}
      </div>`;
  }

  function jumpOptions() {
    const cur = trail[trail.length - 1];
    return NODES.map(([id, kind, , title], i) =>
      `<option value="${id}"${id === cur ? ' selected' : ''}>${i + 1}. ${esc(title)}${kind === 'decision' ? ' (decision)' : ''}</option>`).join('');
  }

  // ── The scenario drawings ─────────────────────────────────────────────────
  // Small line drawings standing in for the original's photographs.
  const wave = y => `<path class="kc-p-water" d="M0 ${y} q7.5 -4 15 0 t15 0 t15 0 t15 0 t15 0 t15 0 t15 0 t15 0"/>`;
  const PICS = {
    flood_warning: ['A gauge post with a flood warning sign, rain falling from a cloud and a flat battery.', `
      <path class="kc-p-ln" d="M10 22 a8 8 0 0 1 10 -10 a10 10 0 0 1 18 2 a7 7 0 0 1 2 14 h-28 a6 6 0 0 1 -2 -6z"/>
      <path class="kc-p-water" d="M16 34 l-3 7 M26 34 l-3 7 M36 34 l-3 7"/>
      <rect class="kc-p-fill" x="66" y="14" width="10" height="50"/>
      <path class="kc-p-ln" d="M66 24 h5 M66 34 h5 M66 44 h5 M66 54 h5"/>
      <path class="kc-p-warn" d="M98 10 l14 24 h-28z M98 18 v8 M98 29 v1"/>
      <path class="kc-p-ln" d="M98 34 v30"/>
      <rect class="kc-p-ln" x="20" y="48" width="22" height="11" rx="1"/><path class="kc-p-ln" d="M42 51 h3 v5 h-3"/>
      <path class="kc-p-bad" d="M24 50 l14 7 M38 50 l-14 7"/>${wave(66)}`],
    warragamba: ['A dam wall holding back a reservoir, with a telemetry mast whose signal has stopped.', `
      <path class="kc-p-fill" d="M0 32 H50 L58 66 H0z"/><path class="kc-p-water" d="M0 32 q6 -3 12 0 t12 0 t12 0 t12 0"/>
      <path class="kc-p-ln" d="M50 26 h14 l14 40 h-28z"/>
      <path class="kc-p-water" d="M80 60 q10 -2 20 2 t20 0"/>
      <path class="kc-p-ln" d="M60 26 v-18 M56 12 l4 -4 4 4"/>
      <path class="kc-p-ln" d="M68 8 a10 10 0 0 1 0 12 M73 4 a16 16 0 0 1 0 20"/>
      <path class="kc-p-bad" d="M80 4 l14 14 M94 4 l-14 14"/>`],
    hs40: ['An instrument enclosure with a gas-bubbler tube running down into the river; a question mark over the cause.', `
      <rect class="kc-p-fill" x="12" y="8" width="38" height="32" rx="2"/><path class="kc-p-ln" d="M31 8 v32 M27 22 h2 M33 22 h2"/>
      <path class="kc-p-ln" d="M18 40 v20 M44 40 v20"/>
      <path class="kc-p-ln" d="M40 40 v8 q0 6 8 6 h36 q6 0 6 6 v4"/>
      <circle class="kc-p-water" cx="92" cy="58" r="2"/><circle class="kc-p-water" cx="96" cy="52" r="1.6"/><circle class="kc-p-water" cx="90" cy="49" r="1.3"/>
      <text class="kc-p-tx kc-p-warn-tx kc-p-big" x="76" y="36">?</text>${wave(62)}`],
    exo: ['A water-quality sonde in the river with a readout: dissolved oxygen zero, the other readings steady.', `<path class="kc-p-water" d="M0 30 q7.5 -4 15 0 t15 0 t15 0 t15 0"/>
      <path class="kc-p-ln" d="M34 4 v12"/>
      <rect class="kc-p-fill" x="27" y="16" width="14" height="44" rx="6"/>
      <path class="kc-p-ln" d="M27 48 h14 M31 52 v6 M37 52 v6"/>
      <rect class="kc-p-fill" x="62" y="10" width="52" height="40" rx="3"/>
      <text class="kc-p-tx kc-p-bad-tx" x="68" y="25">DO 0.0</text>
      <text class="kc-p-tx" x="68" y="37">pH 7.4</text>
      <text class="kc-p-tx" x="68" y="47">EC 412</text>`],
    tbrg: ['A tipping-bucket rain gauge on a stand reading zero while rain falls around it.', `
      <path class="kc-p-water" d="M10 6 l-3 7 M20 14 l-3 7 M100 6 l-3 7 M110 16 l-3 7 M90 20 l-3 7"/>
      <path class="kc-p-ln" d="M38 14 h34 l-6 10 h-22z"/>
      <rect class="kc-p-fill" x="44" y="24" width="22" height="28"/>
      <path class="kc-p-ln" d="M48 52 l-6 14 M62 52 l6 14 M36 66 h38"/>
      <rect class="kc-p-ln" x="82" y="38" width="32" height="16" rx="2"/>
      <text class="kc-p-tx kc-p-bad-tx" x="86" y="50">0 mm</text>`],
    logger: ['A site data logger with its records intact and a clock showing the delay.', `
      <rect class="kc-p-fill" x="10" y="10" width="56" height="50" rx="3"/>
      <rect class="kc-p-ln" x="16" y="16" width="44" height="20"/>
      <path class="kc-p-water" d="M18 32 l6 -6 6 3 6 -8 6 5 6 -4 8 2"/>
      <path class="kc-p-ln" d="M18 44 h20 M18 50 h14 M46 44 h8 v10 h-8z"/>
      <circle class="kc-p-ln" cx="92" cy="26" r="16"/><path class="kc-p-ln" d="M92 16 v10 l7 5"/>
      <path class="kc-p-ok" d="M80 56 l5 5 10 -12"/>`],
    aws: ['A weather-station compound: a Stevenson screen behind a fence with a branch fallen across it.', `
      <rect class="kc-p-fill" x="74" y="8" width="26" height="20"/><path class="kc-p-ln" d="M74 13 h26 M74 18 h26 M74 23 h26 M78 28 v18 M96 28 v18"/>
      <path class="kc-p-ln" d="M6 36 v30 M34 36 v30 M62 36 v30 M90 50 v16 M116 36 v30 M6 44 h56 M6 56 h56 M90 56 h26 M90 44 l8 2 M116 44 h-8"/>
      <path class="kc-p-warn" d="M56 30 L104 58 M70 38 l-6 -10 M86 48 l4 -10"/>
      <path class="kc-p-ln" d="M0 66 h120"/>`],
    encoder: ['A shaft encoder on a stilling well: float, wire over the pulley and counterweight, with a small drift arrow.', `
      <path class="kc-p-ln" d="M30 14 v54 M90 14 v54"/>
      <circle class="kc-p-ln" cx="60" cy="14" r="10"/><rect class="kc-p-fill" x="54" y="2" width="12" height="8"/>
      <path class="kc-p-ln" d="M50 14 v34 M70 14 v20"/>
      <rect class="kc-p-fill" x="42" y="48" width="16" height="7" rx="3"/>
      <rect class="kc-p-fill" x="66" y="34" width="8" height="12"/>
      <path class="kc-p-water" d="M30 54 h60"/>
      <path class="kc-p-warn" d="M100 40 l10 -10 M104 30 h6 v6"/>`],
  };
  function pic(key) {
    const [alt, body] = PICS[key];
    return `<svg class="kc-pic-svg" viewBox="0 0 120 72" role="img" aria-label="${esc(alt)}"><title>${esc(alt)}</title>${body}</svg>`;
  }

  function scenarioCard(s) {
    const [id, key, title, summary, situation, context] = s;
    return `<article class="kc-sc" id="kc-sc-${id}">
      <div class="kc-pic">${pic(key)}</div>
      <h4>${esc(title)}</h4>
      <p>${esc(summary)}</p>
      <details class="kc-more"><summary>The full situation</summary><p>${esc(situation)}</p><p class="small">${esc(context)}</p></details>
      <fieldset class="kc-pick"><legend>Priority<span class="sr-only"> for ${esc(title)}</span></legend>
        ${BUCKETS.map(([b, label]) => `<label><input type="radio" name="kc-p-${id}" value="${b}"${picks[id] === b ? ' checked' : ''}
          onchange="KbLifecycle.pick('${id}', this.value)"> ${esc(label)}</label>`).join('')}
      </fieldset>
      <p class="kc-fb" id="kc-fb-${id}"></p>
    </article>`;
  }

  // ── Page ──────────────────────────────────────────────────────────────────
  function render() {
    if (!order) order = shuffle(SCENARIOS.map(s => s[0]));
    const scs = order.map(id => SCENARIOS.find(s => s[0] === id));
    return `<div class="page kc-page" style="--page-max:960px"><h2 class="sr-only">Site Lifecycle</h2><div class="stack">
      <section class="panel kc-intro">
        <h3>🔁 Running a monitoring site, start to finish</h3>
        <p>Hydrometric site work, in three parts: the <strong>lifecycle</strong> of a site from choosing it to closing it, a
          <strong>routine visit</strong> walked one decision at a time, and a <strong>practice</strong> at deciding which
          visit comes first.</p>
        <p class="small">A companion to trainer-led site work, with examples for discussion and practice — supplementary
          learning, not an operating procedure or an assessment. Follow your organisation's current procedures, safety
          requirements, client requirements and equipment instructions. Anything marked ${WD_TAG} depends on the
          organisation, client, equipment, jurisdiction or approved procedure.</p>
        <nav aria-label="On this page"><div class="button-row kc-jumps">
          <button type="button" class="link-btn" onclick="KbLifecycle.scrollTo('kc-life')">The lifecycle</button>
          <button type="button" class="link-btn" onclick="KbLifecycle.scrollTo('kc-flow')">A routine visit</button>
          <button type="button" class="link-btn" onclick="KbLifecycle.scrollTo('kc-prio')">Practice: visit priority</button>
        </div></nav>
      </section>

      <section class="panel" id="kc-life" aria-labelledby="kc-life-h">
        <h3 id="kc-life-h">The lifecycle, phase by phase</h3>
        <p class="small">Tap a phase — on the drawing or the buttons under it — for what is done in it and why it matters.</p>
        <div class="kc-scroll" role="region" aria-label="Lifecycle drawing" tabindex="0"><div id="kc-life-fig">${lifeSvg()}</div></div>
        <div class="kc-chips" role="group" aria-label="Phases">${phaseButtons()}</div>
        <div id="kc-life-detail" class="kc-detail" aria-live="polite">${phaseDetail()}</div>
      </section>

      <section class="panel" id="kc-flow" aria-labelledby="kc-flow-h">
        <h3 id="kc-flow-h">A routine visit, step by step</h3>
        <p class="small">An example workflow only. It broadly follows a typical visit to a surface-water level and flow
          station — always follow your organisation's standard operating procedures and policies. Choose what happens at
          each step; the drawing marks the path you have taken.</p>
        <div class="kc-scroll" role="region" aria-label="Routine visit flowchart" tabindex="0"><div id="kc-flow-fig">${flowSvg()}</div></div>
        <div class="kc-flow-tools">
          <label for="kc-jump">Go to a step</label>
          <select id="kc-jump" onchange="KbLifecycle.go(this.value, true)">${jumpOptions()}</select>
        </div>
        <div id="kc-flow-step" class="kc-detail" aria-live="polite">${flowStep()}</div>
      </section>

      <section class="panel" id="kc-prio" aria-labelledby="kc-prio-h">
        <h3 id="kc-prio-h">Practice: which visit comes first?</h3>
        <p>Eight situations, four priorities. Pick a priority for each, then review. These are illustrative priorities that
          depend on the stated service and backup assumptions. Respond or escalate first; enter the site only when it is safe
          and approved.</p>
        <h4>The four priorities</h4>
        <ol class="kc-buckets">${BUCKETS.map(([id, label, test, desc]) =>
          `<li class="kc-b-${id}"><strong>${esc(label)}</strong> — ${esc(test)} <span class="small kc-muted">${esc(desc)}</span></li>`).join('')}</ol>
        <div class="kc-grid" id="kc-scs">${scs.map(scenarioCard).join('')}</div>
        <div class="button-row">
          <button type="button" onclick="KbLifecycle.reset()">↺ Reset and reshuffle</button>
          <button type="button" class="primary" onclick="KbLifecycle.review()">✓ Review priorities</button>
        </div>
        <p id="kc-prio-msg" class="kc-msg" aria-live="polite"></p>
      </section>

      <details class="panel kc-section"><summary><h3>Where the guidance comes from</h3></summary>
        <p class="small">The original checks each statement against published guidance, mainly the Bureau of Meteorology's
          National Industry Guidelines for hydrometric monitoring. Its sources:</p>
        <ul class="kc-refs">${REFS.map(([t, org, url]) =>
          `<li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(t)}</a> <span class="small kc-muted">— ${esc(org)}</span></li>`).join('')}</ul>
      </details>

      ${KnowledgeBase.credit('lifecycle')}
    </div></div>`;
  }

  // ── Handlers ──────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  function setPhase(id, focus) {
    if (!PHASES.some(p => p[0] === id)) return;
    phase = id;
    const fig = $('kc-life-fig'), det = $('kc-life-detail');
    if (fig) fig.innerHTML = lifeSvg();
    if (det) det.innerHTML = phaseDetail();
    document.querySelectorAll('.kc-chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.phase === id)));
    if (focus) { const h = $('kc-phase-h'); if (h) h.focus(); }
  }

  function drawFlow(focus) {
    const fig = $('kc-flow-fig'), step = $('kc-flow-step'), sel = $('kc-jump');
    if (fig) fig.innerHTML = flowSvg();
    if (step) step.innerHTML = flowStep();
    if (sel) sel.value = trail[trail.length - 1];
    if (focus) { const h = $('kc-step-h'); if (h) h.focus(); }
  }

  // Follow a branch (fresh: start a new walk from this step instead).
  function go(id, fresh) {
    if (!nodeOf(id)) return;
    if (fresh) trail = [id];
    else trail.push(id);
    drawFlow(true);
  }
  function back() {
    if (trail.length > 1) trail.pop();
    drawFlow(true);
  }

  function clearReview() {
    reviewed = false;
    SCENARIOS.forEach(([id]) => {
      const c = $('kc-sc-' + id), f = $('kc-fb-' + id);
      if (c) c.classList.remove('kc-right', 'kc-wrong');
      if (f) f.textContent = '';
    });
    const m = $('kc-prio-msg');
    if (m) { m.textContent = ''; m.className = 'kc-msg'; }
  }

  function pick(id, bucket) {
    if (!bucketOf(bucket)) return;
    picks[id] = bucket;
    if (reviewed) clearReview();
  }

  function review() {
    const m = $('kc-prio-msg');
    const placed = SCENARIOS.filter(s => picks[s[0]]).length;
    if (placed < SCENARIOS.length) {
      if (m) { m.textContent = `${FB.incomplete} (${placed} of ${SCENARIOS.length} placed.)`; m.className = 'kc-msg kc-msg-warn'; }
      return;
    }
    reviewed = true;
    let right = 0;
    SCENARIOS.forEach(([id, , , , , , want, why]) => {
      const ok = picks[id] === want;
      if (ok) right++;
      const c = $('kc-sc-' + id), f = $('kc-fb-' + id);
      if (c) { c.classList.toggle('kc-right', ok); c.classList.toggle('kc-wrong', !ok); }
      if (f) f.textContent = ok ? '✓ ' + FB.match : 'ⓘ ' + why;
    });
    const all = right === SCENARIOS.length;
    if (m) {
      m.textContent = `${right} of ${SCENARIOS.length} match the suggested priority. ${all ? FB.review : FB.retry}`;
      m.className = 'kc-msg ' + (all ? 'kc-msg-ok' : 'kc-msg-warn');
    }
  }

  function reset() {
    picks = {};
    reviewed = false;
    order = shuffle(SCENARIOS.map(s => s[0]));
    const grid = $('kc-scs');
    if (grid) grid.innerHTML = order.map(id => scenarioCard(SCENARIOS.find(s => s[0] === id))).join('');
    const m = $('kc-prio-msg');
    if (m) { m.textContent = 'Reset — the scenarios are reshuffled.'; m.className = 'kc-msg'; }
  }

  function scrollTo(id) {
    const el = $(id);
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    const h = el.querySelector('h3');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  // The drawings are shortcuts for the buttons beside them: a click on a phase
  // or a step does what its button does. Nothing on them is a tab stop.
  function onFigClick(e) {
    const g = e.target.closest && e.target.closest('[data-phase],[data-node]');
    if (!g) return;
    if (g.dataset.phase) setPhase(g.dataset.phase, false);
    else if (g.dataset.node) go(g.dataset.node, true);
  }

  function init() {
    const life = $('kc-life-fig'), flow = $('kc-flow-fig');
    if (life && !life.dataset.wired) { life.addEventListener('click', onFigClick); life.dataset.wired = '1'; }
    if (flow && !flow.dataset.wired) { flow.addEventListener('click', onFigClick); flow.dataset.wired = '1'; }
    // Re-rendered from state, so a revisit shows where you left off; the
    // review marks are cleared because the cards are drawn fresh.
    reviewed = false;
  }

  return { render, init, phase: setPhase, go, back, pick, review, reset, scrollTo, TAB };
})();

if (typeof window !== 'undefined') window.KbLifecycle = KbLifecycle;
