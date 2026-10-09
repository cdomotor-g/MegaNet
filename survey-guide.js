// MegaNet — survey-guide.js
//
//   SurveyGuide   📖 the Survey Guide tab: "how do I do this again?" for a
//                 station's level survey and the two-peg test — what to have
//                 before you go, choosing the datum, running and booking the
//                 levels, what to survey and how to describe it, the gauge
//                 boards, the water check, checking before you leave, the
//                 reading camera, and what happens once a survey is sent. A
//                 refresher for somebody who knows how, in the order the work
//                 is done; the Level Survey sheet's own "How this part is
//                 done" notes open the matching section here.
//
// After core.js, levelling.js and two-peg.js (whose diagram it borrows),
// before init.js. Reaches back to core.js for state, esc and announce; to
// app.js for switchTab. Nothing runs at load.
//
// The worked example's table is not typed here: it is the practice survey
// (Levelling.practice) reduced by the same arithmetic the sheet uses, so the
// guide and the sheet cannot disagree about a sum.

const SurveyGuide = (function () {
  const TAB = 'surveyguide';
  let pending = null;

  const L = Levelling;
  const f3 = v => (v == null ? '' : L.fmt(v, 3));

  // [id, title, html] — authored here, not user input.
  function sections() {
    const t = L.TOL;
    return [
      ['before', 'Before you go', `
        <p>Pack the site's information and read it before you leave the depot:</p>
        <ul>
          <li>which station it is, and why it is being surveyed this time;</li>
          <li>any old surveys and site drawings;</li>
          <li>the benchmark list — where each mark is, its level, how that level was got, and which one is the main mark;</li>
          <li>gauge zero, and where that figure comes from;</li>
          <li>the datum you are meant to work in;</li>
          <li>a phone number for questions on the day.</li>
        </ul>
        <p>Anything fuzzy about the datum, the main benchmark or gauge zero — sort it out by phone before you set up, and jot down
          in the survey's notes whatever was missing.</p>
        <p>In Flood-Net: open <strong>Level Survey</strong> while you still have coverage and press <strong>Get it ready</strong>, so the
          reading camera works out of range. Your levels and staffs, and the station list, travel with the phone.</p>`],
      ['kit', 'The crew and the kit', `
        <p>A two-person job: one reads the level and books, the other holds the staff.</p>
        <ul>
          <li>The level (in its service period) and its tripod.</li>
          <li>The staff that goes with that level, and a bubble for it.</li>
          <li>A small clamp, so the staff sits firmly on top of a gauge board.</li>
          <li>A tape or a laser distance meter — for the two-peg test and for keeping sights balanced.</li>
          <li>This phone, or a paper level book to copy in later; PPE for the site.</li>
        </ul>
        <p>Staff checks, every time: all sections out and clicked in, bubble in the circle, foot clean and on the right spot.</p>`],
      ['pegtest', 'The two-peg test', `
        <p>It tells you whether the level's line of sight is truly horizontal. Run it before each trip, and again if the level has
          been bumped or bounced around in the vehicle.</p>
        <ol>
          <li>Knock in two pegs (or use two firm marks) roughly 50 m apart on fairly flat ground, and measure the gap.</li>
          <li>Set up dead centre between them. Read peg A, then peg B. The first difference is A minus B.</li>
          <li>Move the level up close to A — 5 m or so away. Read A, then B again, same order. The second difference is A minus B.</li>
          <li>How far apart the two differences are (sign ignored) is the error.</li>
        </ol>
        <p>Why it works: from the middle, both sights are the same length, so any tilt adds the same to each and cancels out of the
          difference. From near A the sights are very different lengths, so a tilt changes the difference. The tab starts with a
          limit of <strong>${f3(t.pegtest)} m</strong> — change it if your site uses another. Over the limit, the level is out of action
          until it has been adjusted or serviced; keep the readings either way.</p>
        <div class="tp-diagrams">${typeof TwoPeg !== 'undefined' && TwoPeg.diagram
          ? `<figure>${TwoPeg.diagram(1, 1.384, 1.517, 0)}<figcaption class="small">First set-up: in the middle.</figcaption></figure>
             <figure>${TwoPeg.diagram(2, 1.553, 1.687, 0.000025)}<figcaption class="small">Second set-up: near A (tilt drawn far bigger than life).</figcaption></figure>` : ''}</div>
        <p><button type="button" onclick="switchTab('twopeg')">🎯 Open the Two-Peg Test</button></p>`],
      ['datum', 'Choosing the datum', `
        <p>A survey works to exactly one datum and says which one. Pick it from what the site gives you:</p>
        <ul class="sg-cards">
          <li><strong>The main benchmark has an AHD level you trust.</strong> Work in AHD from that figure and note where it came from.
            (A level from GNSS only if you've been asked to use one, and only once it has been processed — keep its report.)
            The run gives AHD levels, and gauge levels too once gauge zero is known.</li>
          <li><strong>No dependable AHD, but the gauge boards are trusted.</strong> Call the main benchmark 100.000 (an assumed datum).
            Level every board's reference point, and work gauge zero out from one board you nominate: its surveyed top minus the
            number printed there. If the boards don't agree with each other, book each and raise it — don't average them.
            You get assumed levels and gauge levels.</li>
          <li><strong>Neither.</strong> Call the main benchmark 100.000 and level everything consistently. Only add a gauge-zero
            link if one has been supplied or properly established. You get assumed levels.</li>
        </ul>
        <p>Don't blend assumed, gauge and AHD numbers unless the connection between them is written down — and an AHD figure only
          ever comes from a real AHD connection, never by assumption. Readings and levels are in metres, to the millimetre.</p>`],
      ['benchmarks', 'Benchmarks', `
        <ul>
          <li>Make the main benchmark something permanent — a pin set in concrete or solid rock, or fixed to a lasting structure.
            Pickets, posts and trees move; they don't qualify. Put it above flood reach and where vehicles and mowers won't disturb it.</li>
          <li>New sites: add a mark on the tower base or the hut slab if you can.</li>
          <li>Level any other mark on the site's list. If one comes out different from its listed level, note it and raise it — don't
            swap in the new figure on your own.</li>
          <li>Can't find the main benchmark, or it looks like it has moved? Don't carry on — ring your contact first.</li>
          <li>Naming: <strong>BM</strong> + the station number + <strong>_</strong> + a running number (BM130012_1, BM130012_2…), and a
            description someone else could follow: what the mark is, exactly where, its level and datum.</li>
        </ul>`],
      ['run', 'Running the levels', `
        <ul>
          <li>Walk around first. Find the benchmark, every board, the sensor reference and the control before the tripod goes down.</li>
          <li>Aim for as few set-ups as will do the job properly, and as few staff extensions per point as you can.</li>
          <li>Carry the level through <strong>at least one change point</strong>. Pick change points that won't shift — a rock, a
            concrete edge, a bolt — and note them well enough to find again. Never use a gauge board.</li>
          <li>Balance backsight and foresight lengths in each set-up, and keep sights short — around ${t.sight} m at most.
            Avoid low sight lines over hot ground where the air shimmers.</li>
          <li>Start on the main benchmark, and finish with a foresight back onto it.</li>
        </ul>`],
      ['booking', 'Booking it — rise and fall', `
        <p>Each row is one staff position, in the order you read them. Row 1 is the backsight on the main benchmark, at its known
          level. Every row after that is an intermediate sight (IS) or a foresight (FS). A change point gets both: the foresight
          you took to it, then — after you've moved the level — the backsight from it, side by side on one row. The final row is
          the foresight back onto the benchmark.</p>
        <p>For each row, take its reading away from the previous reading in the same set-up: a positive answer is a rise, a
          negative one a fall. Add the rise (or take off the fall) to the previous level to get this one. At the end, three
          totals must match:</p>
        <p class="sg-eq">ΣBS − ΣFS = ΣRise − ΣFall = last level − first level</p>
        <p>When you finish on the benchmark you started on, that number is the <strong>misclose</strong>. The sheet starts with a
          limit of ±${f3(t.misclose)} m. Here is the practice survey, booked and worked through (gauge zero 26.800 m AHD):</p>
        ${exampleHtml()}
        <p><button type="button" onclick="LevelSurvey.practise(); switchTab('levels')">🎓 Open it as a practice survey</button></p>`],
      ['points', 'What to level', `
        <div class="sg-two">
          <div><h4>Every time</h4><ul>
            <li>The main benchmark — you open on it and close on it.</li>
            <li>Each gauge board at its reference point (normally its top), noting which board it is and the number printed there.</li>
            <li>Where the sensor is referenced — the orifice end or the sensor's datum fitting — on the precise spot that defines it.</li>
            <li>The cease-to-flow control (if you're estimating it, say so).</li>
            <li>The water level and the time you read it, whenever there's water over the sensor reference.</li>
            <li>A GPS fix on every benchmark and on the sensor reference.</li></ul></div>
          <div><h4>When it's there, or you're asked</h4><ul>
            <li>Any other benchmark on the site's list.</li>
            <li>The high point of a nearby road crossing or causeway.</li>
            <li>The hut slab or tower footing.</li>
            <li>Pits along the orifice line.</li>
            <li>Anything flood-relevant you've been asked to pick up.</li>
            <li>Old or other agencies' boards, sensors and marks.</li></ul></div>
        </div>
        <p>If something you'd expect isn't there, write that down — Check and send has a box for each — so nobody later wonders
          whether it was simply forgotten.</p>`],
      ['describe', 'Describing a point', `
        <p>Write each description so a crew that has never been there could put the staff on exactly the same spot:</p>
        <p class="sg-eq">name — what it is, or which bit of it you read, and precisely where. Then anything handy: the time, a photo number.</p>
        <div class="table-wrap"><table><caption class="sr-only">Descriptions, too thin and good enough</caption>
          <thead><tr><th scope="col">Too thin</th><th scope="col">Good enough</th></tr></thead><tbody>
            <tr><td>Mark</td><td>BM999001_1 — stainless pin set in the concrete headwall, left bank, 3 m upstream of the instrument hut. Main benchmark, RL 31.250 m AHD.</td></tr>
            <tr><td>Board</td><td>Top of the 1–2 m gauge board (2.000 m printed), the steel post nearest the water, left bank.</td></tr>
            <tr><td>CP</td><td>CP2 — top of the footbridge's concrete footing, right bank, upstream corner.</td></tr>
            <tr><td>Sensor</td><td>CTR — top of the stainless cap on the sensor housing where the conduit ends, left bank.</td></tr>
            <tr><td>Control</td><td>Approximate CTF — lowest point across the gravel riffle 40 m below the boards, judged by eye.</td></tr>
          </tbody></table></div>
        <p>The sheet offers an opening for each kind of point — tap it and finish the sentence.</p>`],
      ['boards', 'Gauge boards', `
        <ul>
          <li>Put the staff foot exactly on the board's reference point; a little clamp gives it a firm seat instead of balancing
            on the numbers or a bolt head.</li>
          <li>Level every board <strong>as you found it</strong> before anyone touches it.</li>
          <li>Working on a known datum and a main board is out by more than the limit (the sheet starts at ±${f3(t.board)} m —
            use your site's figure if it has one)? Fix it, then level it again and book that as <strong>as left</strong>.
            Keep both.</li>
          <li>New boards go in at their design levels — then level them to show they are.</li>
          <li>If you're working out gauge zero <em>from</em> the boards, leave them alone unless told otherwise — book each one
            and flag any that don't line up.</li>
        </ul>`],
      ['photos', 'Photos', `
        <p>Take them in the sheet (📷 on each point) and they travel with the survey:</p>
        <ul>
          <li>benchmarks — a close shot, and a wider one that shows where they sit;</li>
          <li>each gauge board;</li>
          <li>the sensor reference;</li>
          <li>the whole site;</li>
          <li>the cease-to-flow control and any crossing you levelled.</li>
        </ul>
        <p>Paper notes? Photograph them too and keep them with the survey.</p>`],
      ['water', 'The water check', `
        <ul>
          <li>Only worth doing with water over the sensor reference.</li>
          <li>Get three numbers as close together in time as you can: the water level from your levelling, what the board says,
            and what the logger says.</li>
          <li>Note how far apart they are. There's no pass mark here, and the logger's offset stays as it is unless you've been
            told to change it — that gets sorted out afterwards, from all three.</li>
          <li>No water, or it's under the sensor? Write that down and leave the numbers out.</li>
        </ul>`],
      ['check', 'Before you leave site', `
        <ul>
          <li>You started and finished on the main benchmark, through at least one change point.</li>
          <li>The three totals match, and the misclose — keep its sign — is inside the limit. Over the limit? First look for a
            booking slip. If the sums are right, go round again one set-up at a time using the same change points; only overwrite
            a reading you've actually re-read, and note what you changed. If it still won't close, don't fudge it — file it as
            failed with an explanation, and ring.</li>
          <li>The datum, the benchmark's level and how gauge zero relates to it are all written down.</li>
          <li>Each required point is levelled or noted as absent, and each description would get a stranger to it.</li>
          <li>Photos taken; paper notes kept.</li>
        </ul>
        <p>The sheet's <strong>Check and send</strong> step ticks these off as you work and points to the step that fixes what's left.</p>`],
      ['camera', 'The reading camera', `
        <ul>
          <li>Tap 📷 beside a box, line the level's screen up in the frame and press the button. Hold the phone square to the
            screen and close enough to fill the frame; tilt it slightly if the screen reflects the sky. 🔦 lights a dim screen
            where the phone allows.</li>
          <li>What it read is shown with the picture it came from. <strong>Check it against the screen</strong>, fix it if needed,
            then use it. A staff reading and a distance on the same screen are taken together.</li>
          <li>The picture is kept as evidence — trimmed to the screen, grey, compressed to tens of kilobytes — with a strip saying
            which reading, what was taken, when and where. It goes with the survey, so a number can be checked later.</li>
          <li>Camera won't open, or permission was refused? 🖼️ uses the phone's own camera app or a saved picture: drag a box over
            the screen.</li>
          <li>⌨️ skips the camera and lets you type the number.</li>
          <li>It works out of range once <strong>Get it ready</strong> has been pressed with a signal (about 7 MB, once).</li>
          <li>📷 Read the plate, when adding a level or a staff, picks up its make, model and serial number the same way.</li>
        </ul>`],
      ['sending', 'Sending, and what happens next', `
        <ul>
          <li>Everything is saved on the phone as you go. <strong>Send to Flood-Net</strong> (signed in) files the survey under its
            station, pictures and all — straight away with a signal, or by itself once there is one.</li>
          <li>An administrator looks it over. They may apply what it found to the station — gauge zero, benchmarks, the sensor
            reference, cease to flow, the boards, an offset correction — or send it back with a note saying what it needs.</li>
          <li>Sent back: open it, finish it, send it again. Applied: it becomes a record and is locked — a correction is a new survey.</li>
          <li>At any point: export it as an Excel workbook, a CSV, a survey file for another device, or a package with every photo.</li>
        </ul>`],
    ];
  }

  function exampleHtml() {
    const { survey } = L.practice();
    const red = L.reduce(survey);
    return `<div class="table-wrap" role="region" aria-label="The worked example" tabindex="0"><table class="lv-book">
      <caption class="sr-only">A worked rise-and-fall booking</caption>
      <thead><tr>${['No.', 'BS', 'IS', 'FS', 'Rise', 'Fall', 'RL (AHD)', 'Gauge', 'Point'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead>
      <tbody>${survey.rows.map((r, i) => { const o = red.rows[i];
        return `<tr><td>${i + 1}</td><td>${f3(L.num(r.bs))}</td><td>${f3(L.num(r.is))}</td><td>${f3(L.num(r.fs))}</td><td>${f3(o.rise)}</td><td>${f3(o.fall)}</td>
          <td>${f3(o.rl)}</td><td>${f3(o.lgh)}</td><td>${esc(r.name)}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><th scope="row">Σ</th><td>${f3(red.sums.bs)}</td><td></td><td>${f3(red.sums.fs)}</td><td>${f3(red.sums.rise)}</td><td>${f3(red.sums.fall)}</td><td colspan="3"></td></tr></tfoot>
    </table></div>
    <p class="small">ΣBS − ΣFS = ${L.signed(red.checks.bsfs)}, ΣRise − ΣFall = ${L.signed(red.checks.risefall)}, last − first = ${L.signed(red.checks.lastfirst)}: they agree,
      and the misclose of ${L.signed(red.misclose)} m is inside ±${f3(red.tolerance)} m.</p>`;
  }

  function render() {
    const list = sections();
    return `<div class="page sg-page" style="--page-max:900px"><h2 class="sr-only">Survey Guide</h2><div class="stack">
      <section class="panel sg-intro">
        <h3>📖 How a level survey is done</h3>
        <p>A refresher, in the order the work goes: what to have, the two-peg test, the datum, running and booking the levels, what to
          survey and how to describe it, and checking before you leave. Every step of the Level Survey sheet opens its part of this.</p>
        <nav aria-label="Guide sections"><ol class="sg-toc">${list.map(([id, title]) =>
          `<li><button type="button" class="link-btn" onclick="SurveyGuide.show('${id}')">${esc(title)}</button></li>`).join('')}</ol></nav>
        <div class="button-row"><button type="button" class="primary" onclick="switchTab('levels')">📏 Level Survey</button>
          <button type="button" onclick="switchTab('twopeg')">🎯 Two-Peg Test</button></div>
      </section>
      ${list.map(([id, title, html]) => `<details class="panel sg-section" id="sg-${id}"><summary><h3>${esc(title)}</h3></summary><div class="sg-body">${html}</div></details>`).join('')}
    </div></div>`;
  }

  // Open a section — from the sheet's notes, or the list above.
  function show(id) {
    pending = id;
    if (typeof state !== 'undefined' && state.activeTab === TAB) { reveal(); return; }
    switchTab(TAB);
  }
  function reveal() {
    const id = pending;
    pending = null;
    if (!id) return;
    const el = document.getElementById(`sg-${id}`);
    if (!el) return;
    el.open = true;
    const s = el.querySelector('summary');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    if (s) s.focus({ preventScroll: true });
  }
  function init() { reveal(); }

  return { render, init, show, sections };
})();

if (typeof window !== 'undefined') window.SurveyGuide = SurveyGuide;
