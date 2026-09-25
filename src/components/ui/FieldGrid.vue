<script setup lang="ts">
/**
 * 一组 Field。面板窄（standard、平板、手机）时一列，面板宽（wide）时两列。
 *
 * 按**面板**宽度判，不按视口判：规则在 globals.css 的 `.field-grid`，问的是
 * `efb-panel` 这个容器。用视口前缀的话，1440 的屏上 standard 面板也会被排成两列，
 * 每列不到 200px。
 */
</script>

<template>
  <div class="field-grid">
    <slot />
  </div>
</template>
