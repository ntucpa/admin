/* 管理後台設定（非機密）：後端 API 網址 = Apps Script 固定部署作業網址 */
window.YC_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbw8UHSKeRJP2R_ibRVM73K1yuQyDNvkg63RGVQSTPH1XbHRZ-8esWOMiBGricA-TWsHew/exec',
  /* 快速通道：閘道網址與要走閘道的查詢（閘道的路由表決定由 Cloudflare 或 Apps Script 回答）。要停用請改成 GATEWAY_ACTIONS: {} */
  GATEWAY_URL: 'https://yc-gateway.ntucpa.workers.dev/api',
  GATEWAY_ACTIONS: { getHome: 1, listCompanies: 1, listBindings: 1, listUnclassified: 1, listExceptions: 1, listIntake: 1, listCustomers: 1, customerHistory: 1, listAudit: 1, 'tax.getBoard': 1, 'tax.openPeriod': 1, 'tax.getHome': 1, 'tax.memoSummary': 1, 'tax.saveMemo': 1, 'tax.syncFilings': 1, 'tax.setVatExcluded': 1, 'tax.setPeriodStatus': 1, 'tax.setDeadline': 1, 'tax.markSteps': 1, 'tax.setApplicable': 1, 'tax.setNote': 1, 'tax.addFiling': 1, 'tax.listProfiles': 1, 'tax.saveProfiles': 1, 'tax.checkBills': 1, 'tax.importBill': 1, 'tax.getSettings': 1, 'tax.saveSettings': 1, 'tax.testClassify': 1 }
};
