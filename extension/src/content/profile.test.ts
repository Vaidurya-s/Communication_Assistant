import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractLinkedInProfile, profileExtractionGaps } from "./profile";

/**
 * Fixtures for BOTH LinkedIn profile layouts.
 *
 * `sduiProfile()` reproduces the server-driven layout captured live from a real
 * profile on 2026-08-29 — the one the old selectors were silently failing on.
 * Everything structural in it is observed, not invented:
 *   - card ids of the form `com.linkedin.sdui.profile.card.ref<opaque><Section>`
 *   - no <h1>; the name is an <h2> in the Topcard
 *   - no #about/#experience id anchors, no og: meta tags
 *   - obfuscated hash class names on every element
 *   - zero span[aria-hidden="true"] duplication
 *   - the identity block: name heading in a wrapper div, then the headline and
 *     current-company as DIRECT-CHILD <p>s, with location + "Contact info" in a
 *     nested div, and a "Verify in 2 minutes" promo <p> buried inside an <a>
 *   - a "Top skills" bullet line nested inside the About card
 *
 * The Experience/Education cards are the one part NOT observed: the profile
 * available for capture has none, and reading a stranger's profile to get them
 * was out of scope. They're modelled on the observed card contract (same id
 * scheme, same heading, entries as <li> with <p> leaves), so these tests pin the
 * reader's *contract* rather than proving LinkedIn's exact entry markup.
 *
 * Content is the profile owner's own career data (from their portfolio), so no
 * third party's information appears in the repo.
 */

const REF = "com.linkedin.sdui.profile.card.refACoAAF2MwsMBqo4Ce7W9LL7iMtWkPyBPnunBLuc";
const HASH = "_02484ad3 _1f667e81 f28af954 _1736033f bb60b960";

const ABOUT_TEXT =
  "I'm an Electrical Engineering student at IIT Roorkee with a strong interest in " +
  "FPGA/ASIC design, digital systems, power systems, cybersecurity, and hardware " +
  "acceleration. My work sits at the intersection of hardware and security.";

function sduiProfile(opts: { withLists?: boolean } = {}): string {
  const lists = opts.withLists
    ? `
    <div id="${REF}Experience">
      <div><section><div><div>
        <div><h2 class="${HASH}">Experience</h2></div>
        <ul>
          <li>
            <p class="${HASH}">Research Intern</p>
            <p class="${HASH}">Department of Electrical Engineering, IIT Roorkee</p>
            <p class="${HASH}">May 2025 - Present · 4 mos</p>
          </li>
          <li>
            <p class="${HASH}">Summer Research Intern</p>
            <p class="${HASH}">IEEE Summer Internship</p>
            <p class="${HASH}">Jun 2025 - Aug 2025</p>
          </li>
        </ul>
      </div></div></section></div>
    </div>
    <div id="${REF}Education">
      <div><section><div><div>
        <div><h2 class="${HASH}">Education</h2></div>
        <ul>
          <li>
            <p class="${HASH}">Indian Institute of Technology, Roorkee</p>
            <p class="${HASH}">Bachelor of Technology, Electrical Engineering</p>
            <p class="${HASH}">Aug 2024 - Sept 2028</p>
          </li>
        </ul>
      </div></div></section></div>
    </div>`
    : "";

  return `
  <main>
    <div id="${REF}Topcard">
      <div><section><div><div>
        <div><div><div>
          <div>
            <div><div><h2 class="${HASH}">Vaidurya Shah</h2></div></div>
            <a href="/verify"><div><p class="${HASH}">Verify in 2 minutes</p></div></a>
            <p class="${HASH}">Upcoming Digital Intern @Texas Instruments | Electrical Engineering, IIT Roorkee | Cyber Security, Hardware Design</p>
            <p class="${HASH}">Indian Institute of Technology, Roorkee</p>
            <div>
              <p class="${HASH}">Roorkee, Uttarakhand, India</p>
              <p class="${HASH}">·</p>
              <a href="/overlay/contact-info/"><p class="${HASH}">Contact info</p></a>
            </div>
          </div>
        </div></div>
        <div><div><a href="/x"><p class="${HASH}">500+ connections</p></a></div></div>
      </div></div></section></div>
    </div>

    <div id="${REF}About">
      <div><section><div><div>
        <div><h2 class="${HASH}">About</h2></div>
        <div>
          <p class="${HASH}">${ABOUT_TEXT}<span><button><span><span><span>…</span><span>more</span></span></span></button></span></p>
          <div><div><div><div><div>
            <p class="${HASH}">Top skills</p>
            <p class="${HASH}">Hardware Design • Computer Vision • FPGA prototyping • Xilinx Vivado • Microcontrollers</p>
          </div></div></div></div></div>
        </div>
      </div></div></section></div>
    </div>
    ${lists}
  </main>`;
}

/** The pre-redesign layout, which some accounts still get. Must keep working. */
function legacyProfile(): string {
  return `
  <main>
    <h1>Vaidurya Shah</h1>
    <div class="pv-text-details__left-panel">
      <div class="text-body-medium break-words">Electrical Engineering, IIT Roorkee</div>
      <span class="text-body-small">Roorkee, Uttarakhand, India</span>
    </div>
    <section>
      <div id="about"></div>
      <h2>About</h2>
      <span aria-hidden="true">${ABOUT_TEXT}</span>
    </section>
    <section>
      <div id="experience"></div>
      <h2>Experience</h2>
      <ul>
        <li class="pvs-list__item--line-separated">
          <span aria-hidden="true">Research Intern</span>
          <span aria-hidden="true">IIT Roorkee</span>
          <span aria-hidden="true">May 2025 - Present</span>
        </li>
      </ul>
    </section>
    <section>
      <div id="skills"></div>
      <h2>Skills</h2>
      <ul>
        <li class="pvs-list__item--line-separated">
          <span aria-hidden="true">Verilog</span>
          <span aria-hidden="true">Endorsed by 3 people</span>
        </li>
      </ul>
    </section>
  </main>`;
}

function mount(html: string, title = "Vaidurya Shah | LinkedIn") {
  document.title = title;
  document.body.innerHTML = html;
}

beforeEach(() => {
  window.history.pushState({}, "", "/in/vaidurya-shah-b1775a379/");
  document.body.innerHTML = "";
});

describe("extractLinkedInProfile — server-driven layout", () => {
  it("reads the name from the top card h2 when there is no h1", () => {
    mount(sduiProfile());
    expect(document.querySelector("h1")).toBeNull(); // the layout really has none
    expect(extractLinkedInProfile().name).toBe("Vaidurya Shah");
  });

  it("reads the headline and skips the 'Verify in 2 minutes' promo", () => {
    mount(sduiProfile());
    const p = extractLinkedInProfile();
    expect(p.headline).toContain("Upcoming Digital Intern @Texas Instruments");
    // The promo <p> sits inside an <a> in the same card — a naive
    // "first <p> in the top card" read would have picked it up.
    expect(p.headline).not.toContain("Verify in 2 minutes");
  });

  it("reads the location via the Contact info landmark, not the company line", () => {
    mount(sduiProfile());
    const p = extractLinkedInProfile();
    expect(p.location).toBe("Roorkee, Uttarakhand, India");
    expect(p.location).not.toContain("Contact info");
  });

  it("reads About without the aria-hidden twin, and drops the '…more' toggle", () => {
    mount(sduiProfile());
    // The layout genuinely has no aria-hidden duplication any more.
    expect(document.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0);
    const about = extractLinkedInProfile().about;
    expect(about).toContain("Electrical Engineering student at IIT Roorkee");
    expect(about).not.toMatch(/…\s*more$/);
  });

  it("prefers the long bio over the nested 'Top skills' line in the About card", () => {
    mount(sduiProfile());
    expect(extractLinkedInProfile().about).not.toBe("Top skills");
  });

  it("falls back to the About card's 'Top skills' line when there is no Skills section", () => {
    mount(sduiProfile());
    expect(extractLinkedInProfile().skills).toEqual([
      "Hardware Design",
      "Computer Vision",
      "FPGA prototyping",
      "Xilinx Vivado",
      "Microcontrollers",
    ]);
  });

  it("reads experience and education entries, and derives role/company", () => {
    mount(sduiProfile({ withLists: true }));
    const p = extractLinkedInProfile();
    expect(p.experience[0]).toMatchObject({
      title: "Research Intern",
      company: "Department of Electrical Engineering, IIT Roorkee",
    });
    expect(p.experience).toHaveLength(2);
    expect(p.education[0]).toMatchObject({
      school: "Indian Institute of Technology, Roorkee",
      degree: "Bachelor of Technology, Electrical Engineering",
    });
    // role/company come from the first experience entry.
    expect(p.role).toBe("Research Intern");
  });

  it("does not mistake a section heading for a list entry", () => {
    mount(sduiProfile({ withLists: true }));
    const titles = extractLinkedInProfile().experience.map((e) => e.title);
    expect(titles).not.toContain("Experience");
  });
});

describe("extractLinkedInProfile — legacy layout still works", () => {
  it("reads every field from the pre-redesign DOM", () => {
    mount(legacyProfile());
    const p = extractLinkedInProfile();
    expect(p.name).toBe("Vaidurya Shah");
    expect(p.headline).toBe("Electrical Engineering, IIT Roorkee");
    expect(p.location).toBe("Roorkee, Uttarakhand, India");
    expect(p.about).toContain("Electrical Engineering student");
    expect(p.experience[0]).toMatchObject({ title: "Research Intern", company: "IIT Roorkee" });
  });

  it("keeps filtering endorsement noise out of skills", () => {
    mount(legacyProfile());
    expect(extractLinkedInProfile().skills).toContain("Verilog");
    expect(extractLinkedInProfile().skills.some((s) => /endorsed/i.test(s))).toBe(false);
  });
});

describe("profileExtractionGaps", () => {
  it("names every empty field", () => {
    mount("<main></main>", "LinkedIn");
    const gaps = profileExtractionGaps(extractLinkedInProfile());
    expect(gaps).toEqual(
      expect.arrayContaining(["name", "headline", "location", "about", "experience", "education", "skills"]),
    );
  });

  it("reports nothing when the server-driven layout extracts fully", () => {
    mount(sduiProfile({ withLists: true }));
    expect(profileExtractionGaps(extractLinkedInProfile())).toEqual([]);
  });

  it("warns loudly instead of silently returning an empty shell", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount("<main></main>", "LinkedIn");
    extractLinkedInProfile();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("layout has probably changed"));
    warn.mockRestore();
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});
