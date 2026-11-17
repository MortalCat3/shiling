import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

const globals = Object.fromEntries(
  ['process', 'console', 'URL', 'Buffer', 'fetch', 'AbortSignal', 'setTimeout', 'clearTimeout'].map(
    (key) => [key, 'readonly'],
  ),
);

const workspaceInternals = {
  group: ['@shiling/*/src', '@shiling/*/src/**', '@shiling/*/dist', '@shiling/*/dist/**'],
  message: 'Use a workspace package export instead of an internal path.',
};

export default defineConfig([
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.git/**',
      '**/.impeccable/**',
      '**/secrets.local/**',
      'release-artifacts/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,ts,vue}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [workspaceInternals],
        },
      ],
    },
  },
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
    rules: {
      // TypeScript (vue-tsc) resolves DOM globals and type-only names more accurately than
      // ESLint's JavaScript-only no-undef rule inside <script setup> blocks.
      'no-undef': 'off',
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
      // Prettier is the single source of truth for template whitespace and line wrapping.
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-indent': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,vue}', 'packages/{ui,contracts}/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            workspaceInternals,
            {
              group: [
                'node:*',
                '@shiling/backend',
                '@shiling/backend/**',
                '@shiling/media',
                '@shiling/media/**',
                '**/apps/**',
                '**/packages/**',
              ],
              message: 'Browser-safe code must not import server/runtime internals.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/backend/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            workspaceInternals,
            {
              group: [
                'fastify',
                'pg',
                'pg-boss',
                '@aws-sdk/*',
                'ali-oss',
                '@shiling/media',
                '@shiling/media/**',
              ],
              message: 'Business modules depend on ports; infrastructure belongs in adapters.',
            },
          ],
        },
      ],
    },
  },
]);
