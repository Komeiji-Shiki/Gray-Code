<script setup lang="ts">
defineProps<{ error?: Error }>();
function retry() { window.location.reload(); }
</script>
<template>
  <div class="workspace-loading" :role="error ? 'alert' : 'status'">
    <strong>GRAYCODE</strong>
    <h1>{{ error ? '工作台资源加载失败' : '正在加载工作台…' }}</h1>
    <p>{{ error ? '部分页面资源未能下载，请检查网络后重新加载。' : '首次连接或网络较慢时可能需要更久。' }}</p>
    <button @click="retry">重新加载</button>
  </div>
</template>
<style scoped>
.workspace-loading{min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:clamp(28px,8vw,100px);background:#111317;color:#e4e7ec;font-family:"Segoe UI","Microsoft YaHei",sans-serif}.workspace-loading strong{font-size:14px;letter-spacing:.16em;color:#aab7ca}.workspace-loading h1{font-size:26px;font-weight:500;margin:24px 0 12px}.workspace-loading p{color:#a0a8b5;font-size:14px;line-height:1.7;margin:0}.workspace-loading button{margin-top:24px;padding:11px 18px;border:1px solid #aab7ca;border-radius:0;background:#c5d0df;color:#141b26;font:inherit;cursor:pointer}.workspace-loading button:focus-visible{outline:2px solid #edf3fc;outline-offset:4px}
</style>
