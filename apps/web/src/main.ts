import { createApp } from 'vue';
import App from './App.vue';
import { themeTokens } from '@shiling/ui';
import { router } from './app/router';
import './theme.css';
import './workbench.css';
import './organization.css';
import './administration.css';

for (const [key, value] of Object.entries(themeTokens))
  document.documentElement.style.setProperty(key, value);
createApp(App).use(router).mount('#app');
