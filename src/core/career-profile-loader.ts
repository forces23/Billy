import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CareerContextProvider } from "../interfaces/career-context-provider.js";

export class CareerProfileLoader implements CareerContextProvider {
  readonly #profilePath: string;

  constructor(profilePath: string) {
    if (!profilePath.trim()) {
      throw new Error("A career profile path is required");
    }

    this.#profilePath = resolve(profilePath);
  }

  async load(): Promise<Readonly<Record<string, unknown>>> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(this.#profilePath, "utf8"));
    } catch (error: unknown) {
      throw new Error(
        `Career profile could not be loaded from ${this.#profilePath}`,
        { cause: error },
      );
    }

    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      throw new Error("Career profile must be an object with schemaVersion 1");
    }

    const identity = requireRecord(parsed.identity, "identity");

    // This is intentionally a projection rather than the raw profile. Contact
    // details and internal metadata are excluded from model prompts by default.
    return Object.freeze({
      professionalTitle: nullableString(
        identity.professionalTitle,
        "identity.professionalTitle",
      ),
      professionalLocation: sanitizeLocation(identity.location),
      professionalSummary: nullableString(
        parsed.professionalSummary,
        "professionalSummary",
      ),
      workExperience: sanitizeWorkExperience(parsed.workExperience),
      education: sanitizeEducation(parsed.education),
      skills: sanitizeSkills(parsed.skills),
      projects: sanitizeProjects(parsed.projects),
      certifications: sanitizeCertifications(parsed.certifications),
    });
  }
}

function sanitizeWorkExperience(value: unknown): readonly object[] {
  return requireRecordArray(value, "workExperience").map((role, index) => ({
    company: requiredString(role.company, `workExperience[${index}].company`),
    companyRelationship: nullableString(
      role.companyRelationship,
      `workExperience[${index}].companyRelationship`,
    ),
    title: requiredString(role.title, `workExperience[${index}].title`),
    location: sanitizeLocation(role.location),
    startDate: requiredString(
      role.startDate,
      `workExperience[${index}].startDate`,
    ),
    endDate: nullableString(
      role.endDate,
      `workExperience[${index}].endDate`,
    ),
    isCurrent: role.isCurrent === true,
    clients: sanitizeClients(role.clients, index),
    highlights: requireStringArray(
      role.highlights,
      `workExperience[${index}].highlights`,
    ),
  }));
}

function sanitizeClients(value: unknown, roleIndex: number): readonly object[] {
  if (value === undefined) return [];
  return requireRecordArray(value, `workExperience[${roleIndex}].clients`).map(
    (client, index) => ({
      name: requiredString(
        client.name,
        `workExperience[${roleIndex}].clients[${index}].name`,
      ),
      organization: nullableString(
        client.organization,
        `workExperience[${roleIndex}].clients[${index}].organization`,
      ),
    }),
  );
}

function sanitizeEducation(value: unknown): readonly object[] {
  return requireRecordArray(value, "education").map((item, index) => ({
    institution: requiredString(
      item.institution,
      `education[${index}].institution`,
    ),
    degree: requiredString(item.degree, `education[${index}].degree`),
    fieldOfStudy: requiredString(
      item.fieldOfStudy,
      `education[${index}].fieldOfStudy`,
    ),
    location: sanitizeLocation(item.location),
    startDate: requiredString(
      item.startDate,
      `education[${index}].startDate`,
    ),
    endDate: requiredString(item.endDate, `education[${index}].endDate`),
  }));
}

function sanitizeSkills(value: unknown): Readonly<Record<string, readonly string[]>> {
  const skills = requireRecord(value, "skills");
  return Object.fromEntries(
    Object.entries(skills).map(([category, entries]) => [
      category,
      requireStringArray(entries, `skills.${category}`),
    ]),
  );
}

function sanitizeProjects(value: unknown): readonly object[] {
  return requireRecordArray(value, "projects").map((project, index) => ({
    name: requiredString(project.name, `projects[${index}].name`),
    technologies: requireStringArray(
      project.technologies,
      `projects[${index}].technologies`,
    ),
    highlights: requireStringArray(
      project.highlights,
      `projects[${index}].highlights`,
    ),
    url: nullableString(project.url, `projects[${index}].url`),
  }));
}

function sanitizeCertifications(value: unknown): readonly object[] {
  return requireRecordArray(value, "certifications").map(
    (certification, index) => ({
      name: requiredString(
        certification.name,
        `certifications[${index}].name`,
      ),
      issuer: requiredString(
        certification.issuer,
        `certifications[${index}].issuer`,
      ),
      issuedDate: nullableString(
        certification.issuedDate,
        `certifications[${index}].issuedDate`,
      ),
      expirationDate: nullableString(
        certification.expirationDate,
        `certifications[${index}].expirationDate`,
      ),
    }),
  );
}

function sanitizeLocation(value: unknown): object | null {
  if (value === null || value === undefined) return null;
  const location = requireRecord(value, "location");
  return {
    city: nullableString(location.city, "location.city"),
    state: nullableString(location.state, "location.state"),
    country: nullableString(location.country, "location.country"),
  };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Career profile ${path} must be an object`);
  }
  return value;
}

function requireRecordArray(
  value: unknown,
  path: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`Career profile ${path} must be an array of objects`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Career profile ${path} must be an array of strings`);
  }
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Career profile ${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Career profile ${path} must be a string or null`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
