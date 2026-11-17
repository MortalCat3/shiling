<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
const route = useRoute();
import { setScenario } from './api';
import { identity, loadBootstrap, loadSession } from '../app/session';
const scenario = ref('normal');
const changing = ref(false);
async function change(): Promise<void> {
  changing.value = true;
  try {
    setScenario(scenario.value);
    await loadBootstrap();
    await loadSession(true);
    identity.epoch += 1;
    window.dispatchEvent(new CustomEvent('shiling:assets-changed'));
  } finally {
    changing.value = false;
  }
}
</script>
<template>
  <aside
    class="demo-bar"
    :class="{ 'with-shell': route.path.startsWith('/app') }"
    aria-label="演示模式"
  >
    <span><strong>界面演示</strong> 合成素材 · 操作仅在当前页面内存生效</span
    ><label
      >场景<select v-model="scenario" :disabled="changing" @change="change">
        <option value="normal">正常内容</option>
        <option value="empty">空内容</option>
        <option value="error">读取失败</option>
        <option value="more-error">翻页失败</option>
        <option value="partial">批量部分失败</option>
        <option value="conflict">编辑版本冲突</option>
        <option value="public-closed">公开入口关闭</option>
        <option value="forbidden">普通成员权限</option>
        <option value="fresh-auth">需要再次确认身份</option>
        <option value="anonymous">未登录账号入口</option>
        <option value="setup">尚未初始化</option>
      </select></label
    ><RouterLink :to="route.path.startsWith('/public') ? '/app/collections' : '/public'">{{
      route.path.startsWith('/public') ? '团队集合' : '游客视角'
    }}</RouterLink
    ><RouterLink to="/app/admin/members">团队管理</RouterLink
    ><RouterLink v-if="scenario === 'setup' && !changing" to="/setup">初始化</RouterLink
    ><RouterLink
      v-if="scenario === 'anonymous' && !changing"
      to="/accept-invitation#token=synthetic-invitation-link"
      >邀请入口</RouterLink
    ><RouterLink
      v-if="scenario === 'anonymous' && !changing"
      to="/recover-account#token=synthetic-recovery-link"
      >恢复入口</RouterLink
    ><a href="/app/library">退出演示</a>
  </aside>
</template>
<style scoped>
.demo-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 18px;
  background: #e8eddf;
  color: #3b4f31;
  font-size: 11px;
  position: relative;
  z-index: 40;
}
@media (min-width: 761px) {
  .demo-bar.with-shell {
    margin-left: var(--sidebar-width);
  }
}
.demo-bar strong {
  margin-right: 8px;
  font-weight: 650;
}
.demo-bar label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  white-space: nowrap;
}
.demo-bar select {
  font-size: 11px;
  min-height: 26px;
  padding: 3px 6px;
  background: #f8faf4;
  border: 0;
}
.demo-bar a {
  white-space: nowrap;
  text-decoration: underline;
  text-underline-offset: 3px;
}
@media (max-width: 760px) {
  .demo-bar {
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px;
  }
  .demo-bar > span {
    width: 100%;
  }
  .demo-bar label {
    margin-left: 0;
  }
  .demo-bar a {
    margin-left: auto;
  }
}
</style>
