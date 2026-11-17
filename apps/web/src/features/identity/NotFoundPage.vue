<script setup lang="ts">
import UiState from '../../components/ui/UiState.vue';
</script>
<template>
  <main id="main-content" class="page-content">
    <UiState title="页面不可用" description="地址可能已变更，或当前内容不可访问。"
      ><RouterLink to="/" class="button">返回首页</RouterLink></UiState
    >
  </main>
</template>
