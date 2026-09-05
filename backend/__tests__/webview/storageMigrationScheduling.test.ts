import { migrateStorage, resetStoragePath } from '../../../webview/handlers/StoragePathHandlers';
import type { HandlerContext } from '../../../webview/types';

describe('Webview storage migration scheduling', () => {
    test.each(['migrate', 'reset'])('%s saves an intent without running a live migration', async operation => {
        const storagePathManager = {
            scheduleMigration: jest.fn().mockResolvedValue({ success: true }),
            getDefaultDataPath: jest.fn().mockReturnValue('default-data'),
            migrateData: jest.fn(), resetToDefault: jest.fn()
        };
        const ctx = { storagePathManager, sendResponse: jest.fn(), sendError: jest.fn() } as unknown as HandlerContext;
        if (operation === 'migrate') {
            await migrateStorage({ path: 'new-data' }, 'req', ctx);
            expect(storagePathManager.scheduleMigration).toHaveBeenCalledWith('new-data');
        } else {
            await resetStoragePath({}, 'req', ctx);
            expect(storagePathManager.scheduleMigration).toHaveBeenCalledWith('default-data', true);
        }
        expect(storagePathManager.migrateData).not.toHaveBeenCalled();
        expect(storagePathManager.resetToDefault).not.toHaveBeenCalled();
        expect(ctx.sendResponse).toHaveBeenCalledWith('req', { success: true });
    });
});
