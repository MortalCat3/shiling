<script setup lang="ts">
withDefaults(defineProps<{ name?: string; size?: number }>(), { name: 'grid', size: 20 });
const icons: Record<string, string[]> = {
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  upload: ['M12 16V3m-5 5 5-5 5 5', 'M4 15v5h16v-5'],
  download: ['M12 3v12m-5-5 5 5 5-5', 'M4 17v4h16v-4'],
  folder: ['M3 6h6l2 3h10v11H3z'],
  tag: ['M3 3h8l10 10-8 8L3 11z', 'M7 7h.01'],
  heart: [
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8',
  ],
  archive: ['M3 3h18v5H3zM5 8v13h14V8M9 12h6'],
  image: ['M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4', 'M17 7h.01'],
  video: ['M3 4h18v16H3z', 'm10 8 6 4-6 4z'],
  motion: ['m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z'],
  web_motion: ['m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z'],
  chevron: ['m9 5 7 7-7 7'],
  minus: ['M4 12h16'],
  more: ['M4 12h.01M12 12h.01M20 12h.01'],
  plus: ['M12 4v16M4 12h16'],
  close: ['m6 6 12 12M6 18 18 6'],
  menu: ['M3 5h18M3 12h18M3 19h18'],
  list: ['M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01'],
  filter: ['M3 6h18M3 12h18M3 18h18M8 3v6M16 9v6M8 15v6'],
  user: ['M20 21v-2a8 8 0 0 0-16 0v2', 'M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  users: ['M16 21v-3a6 6 0 0 0-12 0v3M20 21v-3a6 6 0 0 0-3-5', 'M14 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  arrow: ['M20 12H4m6-6-6 6 6 6'],
  link: [
    'm10 14 4-4',
    'M9 15l-2 2a4 4 0 0 1-5-6l5-5a4 4 0 0 1 6 0M15 9l2-2a4 4 0 0 1 5 6l-5 5a4 4 0 0 1-6 0',
  ],
  check: ['m4 12 5 5L20 6'],
  settings: [
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8',
    'M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  ],
  file: ['M5 2h9l5 5v15H5zM14 2v6h5'],
  warning: ['m12 3 10 18H2zM12 9v5m0 3h.01'],
  play: ['m8 4 12 8-12 8z'],
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(path, index) in icons[name] ?? icons.file" :key="index" :d="path" />
  </svg>
</template>
