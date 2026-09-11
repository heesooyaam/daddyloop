import { useState } from 'react';
import { Box, Text, render, useInput, useApp } from 'ink';
import { moduleCatalogue, checkedModules } from '../modules/catalogue.js';
import { translator, type Locale } from '../i18n/index.js';
export async function pickModules(initial: string[], locale: Locale): Promise<string[]> {
  let result: string[] | undefined;
  const t = translator(locale);
  function Picker() {
    const { exit } = useApp();
    const [selected, setSelected] = useState(new Set(initial)),
      [index, setIndex] = useState(0),
      [error, setError] = useState('');
    useInput((input, key) => {
      if (key.upArrow) setIndex((index + moduleCatalogue.length - 1) % moduleCatalogue.length);
      else if (key.downArrow) setIndex((index + 1) % moduleCatalogue.length);
      else if (input === ' ') {
        const next = new Set(selected),
          id = moduleCatalogue[index].id;
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelected(next);
        setError('');
      } else if (key.return) {
        if (
          !moduleCatalogue.some((module) => module.kind === 'agent' && selected.has(module.id)) ||
          !moduleCatalogue.some((module) => module.kind === 'repository' && selected.has(module.id))
        ) {
          setError(t('Choose at least one agent and one repository module.'));
          return;
        }
        result = checkedModules([...selected]);
        exit();
      } else if (key.escape || (key.ctrl && input === 'c')) exit();
    });
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold color="cyan">
          daddyloop · {t('Choose your modules')}
        </Text>
        <Text dimColor>{t('↑/↓ move · Space toggle · Enter install · Esc cancel')}</Text>
        {moduleCatalogue.map((module, i) => (
          <Text key={module.id} color={i === index ? 'cyan' : undefined}>
            {i === index ? '›' : ' '} {selected.has(module.id) ? '☑' : '☐'} {module.name}{' '}
            <Text dimColor>· {t(module.kind === 'agent' ? 'Agent' : 'Repositories')}</Text>
          </Text>
        ))}
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }
  const app = render(<Picker />);
  await app.waitUntilExit();
  if (!result) throw new Error('Module selection cancelled');
  return result;
}
