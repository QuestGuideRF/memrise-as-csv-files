const preloadMenu = async () => {
  if (!await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.createDocument({
		url: "menu.html" ,
		reasons: ["LOCAL_STORAGE"],
		justification: 'предварительная загрузка всплывающего меню'
	});
  }
};
preloadMenu();
const apiTimeout = 25000;
let ongoingTab = null;
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
function downloadFile(options) {
	return new Promise(async (resolve, reject) => {
		let iid, deltas = {};
		const onDownloadComplete = delta => {
			if (iid === undefined) {
				deltas[delta.id] = delta;
			} else if (delta.id == iid) {
				checkDelta(delta);
			}
		}
		chrome.downloads.onChanged.addListener(onDownloadComplete);
		function checkDelta(delta) {
			if (delta.state && delta.state.current === "complete") {
				chrome.downloads.onChanged.removeListener(onDownloadComplete);
				resolve(delta.id);
			} else if (delta.error) {
				chrome.downloads.onChanged.removeListener(onDownloadComplete);
				reject(new Error(delta.error.current));
			} else if (delta.state && delta.state.current === "interrupted") {
				chrome.downloads.onChanged.removeListener(onDownloadComplete);
				reject(new Error(delta.state.current));
			}
		}
		const timeId = setTimeout(async () => {
			if (iid !== undefined) return;
			if (options.url) {
				const query = { url: options.url };
				const items = await chrome.downloads.search(query);
				if (items.length) {
					let item = items[0];
					let iid = item.id;
					if (iid in deltas) {
						console.log(`сохранено с тайм-аутом ${options.filename} | идентификатор элемента = ${iid}`);
						checkDelta(deltas[iid]);
					} else if ((item.state && item.state === "complete") || (item.bytesReceived && item.totalBytes && item.bytesReceived === item.totalBytes)) {
						console.log(`сохранено из журнала с тайм-аутом ${options.filename} | идентификатор элемента = ${iid}`);
						chrome.downloads.onChanged.removeListener(onDownloadComplete);
						resolve(iid);
					} else {
						console.log(`Время загрузки истекло ${options.filename} | идентификатор элемента = ${iid}`);
					}
					return;
				}
			}
			chrome.downloads.onChanged.removeListener(onDownloadComplete);
			reject(new Error("Тайм-аут API"));
		}, apiTimeout);
		try {
			iid = await chrome.downloads.download(options);
		} catch (err) {
			chrome.downloads.onChanged.removeListener(onDownloadComplete);
			return reject(err);
		} finally {
			clearTimeout(timeId);
		}
		if (iid in deltas) checkDelta(deltas[iid]);
	});
}
async function menuAlert(msg, decline_msg = "") {
	await sleep(400);
	chrome.runtime.sendMessage({
		type: "coursedump_alert",
		msg
	}).catch(err=>{
		if (decline_msg) {
			console.log(decline_msg);
		}
	});
}
function updAllMenus() {
	chrome.runtime.sendMessage({
		type: "coursedump_updateOngoings"
	}).catch(err=>{});
}
function ciddsParse(cidd_strings) {
    try {
		return cidd_strings.map(cidd_string => JSON.parse(cidd_string));
    } catch (err) {
		console.error("Ошибка анализа строк cidd: ", err);
		return [];
    }
}
chrome.runtime.onMessage.addListener(async (arg, sender, sendResponse) => {
	if (arg.type === "coursedump_checkOngoing") {
		sendResponse({ "ongoing-status": !!ongoingTab });
		return;
	} else if (arg.type === "coursedump_startDownload") {
		if (ongoingTab) {
			sendResponse({ status: "error", msg: "В другой вкладке уже идёт загрузка" });
			return;
		}
		ongoingTab = arg.tab_id;
		updAllMenus();
		chrome.scripting.executeScript({
			target: {tabId: ongoingTab},
			args: [{'cidds': ciddsParse(arg.cidd_strings), 'settings': arg.settings}],
			func: vars => Object.assign(self, vars),
		}, () => {
			chrome.scripting.executeScript({
				target: {tabId: ongoingTab},
				files: ['progressbars.js']
			}, () => {
					chrome.scripting.executeScript({
						target: {tabId: ongoingTab},
						files: ['coursescan.js']},
						(scanningFeedback) => {
							if (chrome.runtime.lastError) {
								console.log('Вкладка «Скачивание» закрыта.');
								ongoingTab = null;
								menuAlert("Вкладка со сканированием закрыта. Загрузка прервана",
									"открытых меню не осталось, предупреждение о прекращении загрузки не отправлено");
								updAllMenus();
							}
							if (scanningFeedback?.[0]?.result === "сканирование несанкционированное") {
								console.log('Пользователь не вошел в систему. Загрузка прекращена');
								ongoingTab = null;
								updAllMenus();
							} else if (scanningFeedback?.[0]?.result === "сканирование остановлено") {
								console.log('Загрузка остановлена ​​пользователем на этапе сканирования');
								updAllMenus();
							}
						}
					);
				}
			);
		});
		sendResponse({ 'status': "initiated" });
		return;
	} else if (arg.type === "coursedump_stopDownload") {
		if (!ongoingTab) {
			sendResponse({ status: "error", msg: "Нет активных загрузок" });
			updAllMenus();
			return;
		}
		chrome.tabs.sendMessage(ongoingTab, {
			type: "coursedump_stopScan"
		}).then(re => {
			console.log("сигнал остановки сканирования прошел");
		}).catch(err => {
			console.log("Вкладка «Загрузка» больше не существует — сканирование для остановки невозможно.");
		});
		ongoingTab = null;
		console.log("фон остановлен");
		sendResponse({ status: "сигналы остановки отправлены" });
		return;
	}
	const tabId = sender.tab.id;
	if (tabId !== ongoingTab) {
		console.warn(`download request from ${tabId} rejected - ongoing download was initiated by ${ongoingTab}`);
		menuAlert("Запрос на загрузку файла с другой вкладки отклонён");
		return;
	};
	let maxConnections = 5;
	let urls = [];
	if (arg.type === "coursedump_downloadFiles") {
		let terminated = false;
	 	if (arg.file_queue) urls = arg.file_queue;
	 	const todo = urls.length;
	 	if (arg.maxThreads) maxConnections = arg.maxThreads;
	 	console.log(`максимальное количество потоков установлено на: ${maxConnections}`);
	 	let done = 0;
	 	let pids = Array(maxConnections).fill().map((_, i) => i + 1);
	 	const results = await Promise.allSettled(pids.map(async pid => {
	 		while (ongoingTab && urls.length) {
				const [url, filename] = urls.shift();
	 			await sleep(200);
	 			let did;
	 			try {
	 				did = await downloadFile({url, filename, conflictAction: "overwrite" });
	 			} catch (err) {
	 				console.error(filename, err);
					chrome.tabs.sendMessage(tabId, {
						type: "coursedump_error",
						error: err.message,
						url, filename
					}).catch(err => {});
	 			}
	 			if (did !== undefined) {
	 				await chrome.downloads.erase({ id: did });
	 			}
	 			done++;
				chrome.tabs.sendMessage(tabId, {
					type: "coursedump_progressMedia_upd",
					done, todo
				}).catch(err => {
					console.warn(err);
					if (err.message.includes('Не удалось установить соединение. Принимающей стороны не существует.')) {
						console.log('Вкладка «Загрузка» закрыта. прекращение загрузки файла.');
						terminated = true;
						ongoingTab = null;
					}
				})
	 		}
	 	}));
	 	for (let i = 0; i < results.length; i++) {
	 		const r = results[i];
	 		if (r.status === "rejected") {
	 			console.error(`pid ${i + 1}: ${r.reason}`);
	 		}
	 	}
		if (ongoingTab) {
			chrome.tabs.sendMessage(tabId, {
				type: "coursedump_mediaFinished",
				status: "done"
			}).catch(err => {});
			ongoingTab = null;
		} else {
			if (!terminated) {
				console.log('Загрузка остановлена ​​пользователем на этапе загрузки файла');
			} else {
				console.log('Вкладка «Загрузка» была закрыта на этапе загрузки файла.');
				menuAlert("Вкладка загрузки закрыта. Загрузка прервана",
					"открытых меню не осталось, предупреждение о прекращении загрузки не отправлено");
			}
			chrome.tabs.sendMessage(tabId, {
				type: "coursedump_mediaFinished",
				status: "stopped"
			}).catch(err => {});
		}
		updAllMenus();
	}
});