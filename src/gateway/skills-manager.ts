/**
 * skills-manager.ts - Skills System for LocalClaw
 * 
 * Reads SKILL.md files from .localclaw/skills/<name>/SKILL.md
 * Parses YAML frontmatter + markdown instructions
 * Tracks enabled/disabled state in config
 * Injects enabled skills into system prompt
 * 
 * Compatible with OpenClaw SKILL.md format.
 */

import fs from 'fs';
import path from 'path';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Skill {
  id: string;             // folder name = id
  name: string;           // from frontmatter or id
  description: string;    // from frontmatter
  emoji: string;          // from frontmatter or default
  version: string;        // from frontmatter
  enabled: boolean;       // from config
  instructions: string;   // markdown body (everything after frontmatter)
  filePath: string;       // full path to SKILL.md
  createdAt: number;      // file creation time
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  emoji?: string;
  version?: string;
  [key: string]: any;
}

// ─── YAML Frontmatter Parser (simple, no deps) ────────────────────────────────

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed };
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: trimmed };
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  // Simple YAML key: value parser (handles most SKILL.md files)
  const frontmatter: SkillFrontmatter = {};
  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (match) {
      const key = match[1].trim();
      let val = match[2].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
    }
  }

  return { frontmatter, body };
}

// ─── Skills Manager ────────────────────────────────────────────────────────────

export class SkillsManager {
  private skillsDir: string;
  private configPath: string;
  private skills: Map<string, Skill> = new Map();
  private enabledState: Record<string, boolean> = {};

  constructor(skillsDir: string, configPath: string) {
    this.skillsDir = skillsDir;
    this.configPath = configPath;

    // Ensure skills directory exists
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }

    this.loadEnabledState();
    this.scanSkills();
  }

  // Load enabled/disabled state from a simple JSON file
  private loadEnabledState() {
    const statePath = path.join(path.dirname(this.skillsDir), 'skills_state.json');
    try {
      if (fs.existsSync(statePath)) {
        this.enabledState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      }
    } catch {
      this.enabledState = {};
    }
  }

  private saveEnabledState() {
    const statePath = path.join(path.dirname(this.skillsDir), 'skills_state.json');
    try {
      fs.writeFileSync(statePath, JSON.stringify(this.enabledState, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Skills] Failed to save state:', err);
    }
  }

  // Scan skills directory for SKILL.md files
  scanSkills() {
    // Refresh persisted enabled-state before rebuilding skill list.
    this.loadEnabledState();
    this.skills.clear();

    if (!fs.existsSync(this.skillsDir)) return;

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(this.skillsDir, entry.name);
      const skillMd = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillMd)) continue;

      try {
        const content = fs.readFileSync(skillMd, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(content);
        const stat = fs.statSync(skillMd);

        const skill: Skill = {
          id: entry.name,
          name: frontmatter.name || entry.name,
          description: frontmatter.description || '',
          emoji: frontmatter.emoji || '🧩',
          version: frontmatter.version || '1.0.0',
          enabled: this.enabledState[entry.name] ?? false,
          instructions: body,
          filePath: skillMd,
          createdAt: stat.ctimeMs || Date.now(),
        };

        this.skills.set(entry.name, skill);
      } catch (err) {
        console.error(`[Skills] Failed to load ${entry.name}:`, err);
      }
    }

    console.log(`[Skills] Loaded ${this.skills.size} skills (${this.getEnabledSkills().length} enabled)`);
  }

  // Persist current enabled-state map to disk (best effort).
  persistState() {
    this.saveEnabledState();
  }

  // Get all skills
  getAll(): Skill[] {
    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Get enabled skills only
  getEnabledSkills(): Skill[] {
    return this.getAll().filter(s => s.enabled);
  }

  // Get a single skill
  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  // Toggle skill enabled/disabled
  toggle(id: string): Skill | null {
    const skill = this.skills.get(id);
    if (!skill) return null;

    skill.enabled = !skill.enabled;
    this.enabledState[id] = skill.enabled;
    this.saveEnabledState();

    console.log(`[Skills] ${skill.name}: ${skill.enabled ? 'ENABLED' : 'DISABLED'}`);
    return skill;
  }

  // Enable or disable explicitly
  setEnabled(id: string, enabled: boolean): Skill | null {
    const skill = this.skills.get(id);
    if (!skill) return null;

    skill.enabled = enabled;
    this.enabledState[id] = enabled;
    this.saveEnabledState();

    console.log(`[Skills] ${skill.name}: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return skill;
  }

  // Create a new skill from user input
  create(data: {
    id: string;
    name: string;
    description: string;
    emoji?: string;
    instructions: string;
  }): Skill {
    // Sanitize id: lowercase, alphanumeric + hyphens only
    const id = data.id
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!id) throw new Error('Invalid skill ID');

    const skillDir = path.join(this.skillsDir, id);
    fs.mkdirSync(skillDir, { recursive: true });

    // Build SKILL.md content
    const frontmatterLines = [
      '---',
      `name: ${data.name}`,
      `description: ${data.description}`,
    ];
    if (data.emoji) frontmatterLines.push(`emoji: "${data.emoji}"`);
    frontmatterLines.push(`version: 1.0.0`);
    frontmatterLines.push('---');

    const content = frontmatterLines.join('\n') + '\n\n' + data.instructions;
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, content, 'utf-8');

    // Auto-enable new skills
    this.enabledState[id] = true;
    this.saveEnabledState();

    // Reload
    this.scanSkills();

    const skill = this.skills.get(id);
    if (!skill) throw new Error('Skill creation failed');

    console.log(`[Skills] Created: ${data.name} (${id})`);
    return skill;
  }

  // Delete a skill
  delete(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;

    try {
      const skillDir = path.join(this.skillsDir, id);
      fs.rmSync(skillDir, { recursive: true, force: true });
      this.skills.delete(id);
      delete this.enabledState[id];
      this.saveEnabledState();
      console.log(`[Skills] Deleted: ${id}`);
      return true;
    } catch (err) {
      console.error(`[Skills] Failed to delete ${id}:`, err);
      return false;
    }
  }

  // Update a skill's instructions
  update(id: string, data: {
    name?: string;
    description?: string;
    emoji?: string;
    instructions?: string;
  }): Skill | null {
    const skill = this.skills.get(id);
    if (!skill) return null;

    // Read existing file, update frontmatter and body
    const content = fs.readFileSync(skill.filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    if (data.name) frontmatter.name = data.name;
    if (data.description) frontmatter.description = data.description;
    if (data.emoji) frontmatter.emoji = data.emoji;

    const newBody = data.instructions ?? body;

    const frontmatterLines = ['---'];
    for (const [key, val] of Object.entries(frontmatter)) {
      if (val !== undefined && val !== null) {
        frontmatterLines.push(`${key}: ${String(val)}`);
      }
    }
    frontmatterLines.push('---');

    const newContent = frontmatterLines.join('\n') + '\n\n' + newBody;
    fs.writeFileSync(skill.filePath, newContent, 'utf-8');

    this.scanSkills();
    return this.skills.get(id) || null;
  }

  /**
   * Build the skills context string for the system prompt.
   * Only includes enabled skills. Keeps it compact for 4B context.
   */
  buildPromptContext(maxCharsPerSkill: number = 300): string {
    const enabled = this.getEnabledSkills();
    if (enabled.length === 0) return '';

    const parts: string[] = ['[ACTIVE SKILLS]'];

    for (const skill of enabled) {
      // Trim instructions to fit context budget
      const instructions = skill.instructions.length > maxCharsPerSkill
        ? skill.instructions.slice(0, maxCharsPerSkill) + '...'
        : skill.instructions;

      parts.push(`\n## ${skill.emoji} ${skill.name}\n${instructions}`);
    }

    return parts.join('\n');
  }
}
