/**
 * web_search 工具注册
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'

const WebSearchComponent = lazyToolComponent(() => import('../../../components/tools/web/web_search.vue'))

registerTool('web_search', {
  name: 'web_search',
  labelFormatter: () => getToolDisplayName('web_search'),
  icon: 'codicon-globe',

  descriptionFormatter: args => {
    if (typeof args.query === 'string' && args.query.trim()) return args.query
    return getToolMetaDescription('web_search') ?? getToolDisplayName('web_search')
  },

  contentComponent: WebSearchComponent
})
