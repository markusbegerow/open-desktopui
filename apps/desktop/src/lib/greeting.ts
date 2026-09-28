// A pool of varied Home-screen greetings — picked once per visit (see
// HomeView.tsx) rather than always showing the same "What's next?" line.
// Each template independently handles the case where no display name is
// known yet, since `displayName` resolves asynchronously after HomeView
// mounts and the same random pick has to read naturally either way.
export const GREETING_TEMPLATES: Array<(name?: string) => string> = [
  (name) => `What's next${name ? `, ${name}` : ""}?`,
  (name) => (name ? `Good to see you, ${name}.` : "Good to see you."),
  (name) => `Where should we start${name ? `, ${name}` : ""}?`,
  (name) => (name ? `Ready when you are, ${name}.` : "Ready when you are."),
  (name) => `What are we building today${name ? `, ${name}` : ""}?`,
  (name) => (name ? `Hey ${name}, what's on your mind?` : "What's on your mind?"),
  (name) => (name ? `Welcome back, ${name}.` : "Welcome back."),
  (name) => `What would you like to do${name ? `, ${name}` : ""}?`,
];

export function pickGreetingIndex(): number {
  return Math.floor(Math.random() * GREETING_TEMPLATES.length);
}

export function renderGreeting(index: number, name?: string): string {
  const template = GREETING_TEMPLATES[index] ?? GREETING_TEMPLATES[0];
  return template(name);
}
