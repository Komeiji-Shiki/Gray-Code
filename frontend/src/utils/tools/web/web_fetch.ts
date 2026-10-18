/**
 * web_fetch 工具注册
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'

const WebFetchComponent = lazyToolComponent(() => import('../../../components/tools/web/web_fetch.vue'))

registerTool('web_fetch', {
  name: 'web_fetch',
  labelFormatter: () => getToolDisplayName('web_fetch'),
  icon: 'codicon-file-text',

  descriptionFormatter: args => {
    if (typeof args.url === 'string' && args.url.trim()) return args.url
    return getToolMetaDescription('web_fetch') ?? getToolDisplayName('web_fetch')
  },

  contentComponent: WebFetchComponent
})
