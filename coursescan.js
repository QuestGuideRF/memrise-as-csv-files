ANKI_HEADERS = true;
console.log('Настройки дампа курса: ', settings);
console.log('Пакет дампа курса: ', JSON.stringify(cidds));
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
function ciddToURL(cidd) {
  return `https://${cidd['domain']}/community/course/${cidd['cid']}`;
}
function fetchURL(domain) {
	return `https://${domain}/v2.0/learning_sessions/preview/`;
}
async function fetchMeta(cidd) {
  const meta = {
    'url': ciddToURL(cidd),
    'cid': cidd['cid'],
    'имя собственное': '',
    'thumbnail': '',
    'URL-адрес': cidd['cid'],
    'количество уровней': '??',
    'количество предметов': '??',
    'description': '',
    'author': '',
    'ava': 'https://static.memrise.com/accounts/img/placeholders/empty-avatar-2.png',
  };
  let course_page;
  try {
    course_page = await fetch(ciddToURL(cidd));
  } catch(err) {
    console.error(`не удалось получить HTML-код курса ${cidd['cid']}.`, err);
  }
  if (!course_page) return meta;
  meta['URL-адрес'] = course_page.url.split("/")[6];
  try {
    const parser =  new DOMParser();
    const doc = parser.parseFromString(await course_page.text(), "text/html");
    meta['имя собственное'] = doc.querySelector('.course-name').innerText;
    meta['thumbnail'] = doc.querySelector('.course-photo img').src;
    meta['количество уровней'] = (query => (query ? query.childElementCount : 1))(doc.querySelector('div.levels'));
    meta['description'] = (desc => (desc ? desc.innerText : ""))(doc.querySelector('.course-description.text'));
    meta['author'] = doc.querySelector('Диапазон .creator-name').innerText;
    meta['ava'] = doc.querySelector('.creator-image img').src;
    try {
      meta['количество предметов'] = parseInt(doc.querySelector('.progress-box-title').innerText.split('/').at(-1).trim(), 10).toString();
    } catch(err) {
      console.log(`курс ${cidd['cid']} не запущен, информация о «количестве предметов» недоступна`);
    }
  } catch(err) {
    console.error(`не удалось разобрать html курса ${cidd['cid']}`, err);
  }
	console.log(meta);
  return meta;
}
function meta2txt(meta) {
	let text = 'данные:md/plain;кодировка=utf-8,' + encodeURIComponent(
		`# **${meta['proper name'] || meta['url name']}**\n` +
		`### от _${meta['author']}_\n` +
		`### (${meta['number of items']} изучаемые элементы)\n` +
		`\n` +
		meta['description']
		);
	if (!ANKI_HEADERS) {
		text = text + encodeURIComponent(
		`\n\n` +
		`## Поля курса\n` +
		`| ${meta['course fields']} |`
		);
	}
  return text;
}
function wrapAlts(alts, hidden=false) {
	return `\n<div class="alt"${ hidden ? ' hidden' : '' }>${ [...alts].join(" | ") }</div>`;
}
async function scanCourse(cidd, threadN) {
  let stopped = false;
  function stopScan(arg, sender, sendResponse) {
    if (arg.type === "coursedump_stopScan") {
      chrome.runtime.onMessage.removeListener(stopScan);
      stopped = true;
    }
  }
  chrome.runtime.onMessage.addListener(stopScan);
  updScanProgress(threadN, cidd, 0, "", "");
  const meta = await fetchMeta(cidd);
  await sleep(500);
  updScanProgress(threadN, cidd, 0, meta['количество уровней'], meta['имя собственное'] || meta['URL-адрес']);
  let reserved_filenames = new Set();
	let url2filenames = {};
	function UniqueDecodedFilename(url) {
		if (url in url2filenames) {return url2filenames[url];}
		let	temp_filename = decodeURIComponent(url.split("/").slice(-1)[0]);
		temp_filename = meta['URL-адрес'] + "_" + cidd['cid'] + cidd['domain'][0] + "_" + temp_filename;
		temp_filename = temp_filename.replace('[','(').replace(']',')');
		let name_parts = temp_filename.split('.');
		const ext = name_parts.pop().toLowerCase();
		const proper = name_parts.join(".");
		temp_filename = proper + "." + ext;
		if (reserved_filenames.has(temp_filename)) {
			for (let i = 1; reserved_filenames.has(temp_filename); i++) {
				temp_filename = proper + " (" + i + ")." + ext;
			}
		}
		url2filenames[url] = temp_filename;
		reserved_filenames.add(temp_filename);
		return temp_filename;
	}
	function isURL(str) {
		return str.startsWith("https://static.memrise.com");
	}
  let err_count = 0;
	let has_audio = false;
	let has_video = false;
	const attributes = [];
	const visible_info = [];
	const hidden_info = [];
	let has_definitions = false;
	let has_learnable = false;
	const course_media_urls = new Set();
	const table = [];
  let levels_done = 0;
  let proceed = true;
  while ((proceed || levels_done < meta['количество уровней']) && !stopped) {
    levels_done += 1;
    let level_is_empty = false;
		try {
			const token = document.cookie.split(" ").find(cookie => cookie.includes("csrftoken")).split(/[=;]/g)[1];
			const response = await fetch(fetchURL(cidd['domain']), {
				"headers": {
					"Accept": "*/*",
					"Content-Type": "Application/json",
					"X-CSRFToken": token
				},
				"body": JSON.stringify({
					session_source_id: cidd['cid'],
					session_source_type: "course_id_and_level_index",
					session_source_sub_index: levels_done
				}),
				"method": "POST"
			});
			if (!response.ok) {
				if (response.status === 401) {
					if (threadN === 0) {
						alert("Требуется вход в Memrise");
					}
					return "unauthorised";
				}
			}
			const response_json = await response.json();
			if (response_json.code == "PREVIEW_DOESNT_LOAD") {
				level_is_empty = true;
			}
			let tags = `"` + meta['URL-адрес'] + `"`;
			if (settings["level_tags"]) {
				try {
					tags = `"` + response_json.session_source_info.name.replaceAll('"', '""') +
                      `::` + levels_done.toString().padStart(meta['количество уровней'].toString().length, "0") +
                      `_` + response_json.session_source_info.level_name.replaceAll('"', '""') + `"`;
				} catch (err) {console.log(`${err.name}: ${err.message}`);}
				tags = tags.replaceAll(' ','_');
			}
			response_json.learnables.map(learnable => {
				const row = [];
				const meta = {};
				let learnable_el = `""`;
				if (learnable.learning_element) {
					has_learnable = true;
					learnable_el = learnable.learning_element;
					if (settings["alternative_answers"]) {
						const alts = learnable?.screens?.["1"]?.item?.alternatives;
						const allAnss = Object.values(learnable.screens).find(screen=>screen.template==="typing")?.correct;
						const hiddenAlts = allAnss?.filter(ans => ans.toLowerCase().trim() !== learnable_el.toLowerCase().trim() && !alts.includes(ans));
						if (Array.isArray(alts) && alts.length > 0) {
							learnable_el += wrapAlts(alts);
						}
						if (Array.isArray(hiddenAlts) && hiddenAlts.length > 0) {
							learnable_el += wrapAlts(hiddenAlts, true);
						}
					}
					learnable_el = `"${learnable_el.replaceAll('"', '""')}"`;
				} else if (settings["download_media"] && learnable.screens["1"].item.kind === "audio" && learnable.screens["1"].item.value.length > 0) {
					has_learnable = true;
					let temp_audio_learns = [];
					learnable.screens["1"].item.value.map(audio_learn => {temp_audio_learns.push(audio_learn.normal)});
					temp_audio_learns.forEach(course_media_urls.add, course_media_urls);
					learnable_el = `"` + temp_audio_learns.map(url => `[звук:${UniqueDecodedFilename(url)}]`).join("") + `"`;
				} else if (settings["download_media"] && learnable.screens["1"].item.kind === "image" && learnable.screens["1"].item.value.length > 0) {
					has_learnable = true;
					let temp_image_learns = [];
					learnable.screens["1"].item.value.map(image_learn => {temp_image_learns.push(image_learn)});
					temp_image_learns.forEach(course_media_urls.add, course_media_urls);
					learnable_el = `"` + temp_image_learns.map(url => `<img src='${UniqueDecodedFilename(url)}'>`).join(``) + `"`;
				}
				meta["learnable"] = learnable?.screens?.["1"]?.item?.label;
				row.push(learnable_el);
				let definition = `""`;
				if (learnable.definition_element) {
					has_definitions = true;
					definition = learnable.definition_element;
					if (settings["alternative_answers"]) {
						const alts = learnable?.screens?.["1"]?.definition?.alternatives;
						if (Array.isArray(alts) && alts.length > 0) {
							definition += wrapAlts(alts);
						}
					}
					definition = `"${definition.replaceAll('"', '""')}"`;
				} else if (settings["download_media"] && learnable.screens["1"].definition.kind === "audio" && learnable.screens["1"].definition.value.length > 0) {
					has_definitions = true;
					let temp_audio_defs = [];
					learnable.screens["1"].definition.value.map(audio_def => {temp_audio_defs.push(audio_def.normal)});
					temp_audio_defs.forEach(course_media_urls.add, course_media_urls);
					definition = `"` + temp_audio_defs.map(url => `[звук:${UniqueDecodedFilename(url)}]`).join("") + `"`;
				} else if (settings["download_media"] && learnable.screens["1"].definition.kind === "image" && learnable.screens["1"].definition.value.length > 0) {
					has_definitions = true;
					let temp_image_defs = [];
					learnable.screens["1"].definition.value.map(image_def => {temp_image_defs.push(image_def)});
					temp_image_defs.forEach(course_media_urls.add, course_media_urls);
					definition = `"` + temp_image_defs.map(url => `<img src='${UniqueDecodedFilename(url)}'>`).join(``) + `"`;
				}
				meta["definition"] = learnable?.screens?.["1"]?.definition?.label;
				row.push(definition);
				let choices = learnable?.screens?.["2"]?.choices;
				if (choices) {
					meta["choices"] = choices.map(choice => isURL(choice) ? UniqueDecodedFilename(choice) : choice);
				}
				choices = learnable?.screens?.["3"]?.choices;
				if (choices) {
					meta["обратный выбор"] = choices.map(choice => isURL(choice) ? UniqueDecodedFilename(choice) : choice);
				}
				let temp_audio_urls = [];
				if (settings["download_media"] && learnable.screens["1"].audio && learnable.screens["1"].audio.value.length > 0) {
					has_audio = true;
					learnable.screens["1"].audio.value.map(audio_item => {temp_audio_urls.push(audio_item.normal)});
					temp_audio_urls.forEach(course_media_urls.add, course_media_urls);
				}
				row.push(`"` + temp_audio_urls.map(url => `[звук:${UniqueDecodedFilename(url)}]`).join("") + `"`);
				let temp_video_urls = [];
				if (settings["download_media"] && settings["videofiles_limit"] > 0 && learnable.screens["1"].video && learnable.screens["1"].video.value.length > 0) {
					has_video = true;
					learnable.screens["1"].video.value.map(video_item => {temp_video_urls.push(video_item)});
					temp_video_urls.forEach(course_media_urls.add, course_media_urls);
				}
				row.push(`"` + temp_video_urls.map(url => `[звук:${UniqueDecodedFilename(url)}]`).join("") + `"`);
				let temp_extra1 = new Array(settings["max_extra_fields"]).fill(``);
				if (settings["extra_fields"] && learnable.screens["1"].attributes && learnable.screens["1"].attributes.length > 0) {
					learnable.screens["1"].attributes.forEach(attribute => {
						if (attribute && attribute.value && attribute.label) {
							let ind = attributes.indexOf(attribute.label);
							if (ind == -1 && attributes.length < settings["max_extra_fields"]) {
								attributes.push(attribute.label);
							}
							ind = attributes.indexOf(attribute.label);
							if (ind != -1) {
								temp_extra1[ind] = `"${attribute.value.replaceAll('"', '""')}"`;
							}
						}
					})
				}
				temp_extra1.forEach(el => row.push(el));
				let temp_extra2 = new Array(settings["max_extra_fields"]).fill(``);
				if (settings["extra_fields"] && learnable.screens["1"].visible_info && learnable.screens["1"].visible_info.length > 0) {
					learnable.screens["1"].visible_info.forEach(v_info => {
						if (v_info && v_info.value && v_info.label) {
							let ind = visible_info.indexOf(v_info.label);
							if (ind == -1 && visible_info.length < settings["max_extra_fields"]) {
								visible_info.push(v_info.label);
							}
							ind = visible_info.indexOf(v_info.label);
							if (ind != -1) {
								if (settings["download_media"] && v_info.kind === "audio" && v_info.value.length > 0) {
									let temp_audio_list = [];
									v_info.value.map(audio => {temp_audio_list.push(audio.normal)});
									temp_audio_list.forEach(course_media_urls.add, course_media_urls);
									temp_extra2[ind] = `` + temp_audio_list.map(url => `[звук:${UniqueDecodedFilename(url)}]`).join("") + ``;
								} else if (settings["download_media"] && v_info.kind === "image" && v_info.value.length > 0) {
									let temp_image_list = [];
									v_info.value.map(image => {temp_image_list.push(image)});
									temp_image_list.forEach(course_media_urls.add, course_media_urls);
									temp_extra2[ind] = `` + temp_image_list.map(url => `<img src='${UniqueDecodedFilename(url)}'>`).join(``) + ``;
								} else if (v_info.kind !== "audio" && v_info.kind !== "image") {
									temp_extra2[ind] = v_info.value;
									if (settings["alternative_answers"]) {
										const alts = v_info.alternatives;
										if (Array.isArray(alts) && alts.length > 0) {
											temp_extra2[ind] += wrapAlts(alts);
										}
									}
									temp_extra2[ind] = `"${temp_extra2[ind].replaceAll('"', '""')}"`;
								}
							}
						}
					})
				}
				temp_extra2.forEach(el => row.push(el));
				let temp_extra3 = new Array(settings["max_extra_fields"]).fill(``);
				if (settings["extra_fields"] && learnable.screens["1"].hidden_info && learnable.screens["1"].hidden_info.length > 0) {
					learnable.screens["1"].hidden_info.forEach(h_info => {
						if (h_info && h_info.value && h_info.label) {
							let ind = hidden_info.indexOf(h_info.label);
							if (ind == -1 && hidden_info.length < settings["max_extra_fields"]) {
								hidden_info.push(h_info.label);
							}
							ind = hidden_info.indexOf(h_info.label);
							if (ind != -1) {
								if (settings["download_media"] && h_info.kind === "audio" && h_info.value.length > 0) {
									let temp_audio_list = [];
									h_info.value.map(audio => {temp_audio_list.push(audio.normal)});
									temp_audio_list.forEach(course_media_urls.add, course_media_urls);
									temp_extra3[ind] = `` + temp_audio_list.map(url => `[звук:${UniqueDecodedFilename(url)}]`).join("") + ``;
								} else if (settings["download_media"] && h_info.kind === "image" && h_info.value.length > 0) {
									let temp_image_list = [];
									h_info.value.map(image => {temp_image_list.push(image)});
									temp_image_list.forEach(course_media_urls.add, course_media_urls);
									temp_extra3[ind] = `` + temp_image_list.map(url => `<img src='${UniqueDecodedFilename(url)}'>`).join("") + ``;
								} else if (h_info.kind !== "audio" && h_info.kind !== "image") {
									temp_extra3[ind] = h_info.value;
									if (settings["alternative_answers"]) {
										const alts = h_info.alternatives;
										if (Array.isArray(alts) && alts.length > 0) {
											temp_extra3[ind] += wrapAlts(alts);
										}
									}
									temp_extra3[ind] = `"${temp_extra3[ind].replaceAll('"', '""')}"`;
								}
							}
						}
					})
				}
				temp_extra3.forEach(el => row.push(el));
				row.push(tags);
				let lid = learnable?.id || -1;
				if (settings["learnable_ids"]) {
					row.push(lid);
				}
				if (settings["learning_progress"]) {
					const prog_data = response_json.progress.find(item => item.learnable_id == lid);
					row.push(`"${JSON.stringify(prog_data || "new").replaceAll('"', '""')}"`);
				}
				if (settings["learnable_meta"]) {
					row.push(`"${JSON.stringify(meta).replaceAll('"', '""')}"`);
				}
				table.push(row);
			});
			err_count = 0;
		} catch (err) {
			console.log(err);
			if (level_is_empty) {
				console.log(`${cidd['cid']}: на уровне ${levels_done} нет предметов для изучения.`);
			} else {
			  console.log(`${cidd['cid']}: Level ${levels_done} does not exist or has no learnable words. Level skip count: ` + (err_count + 1));
			  err_count++;
			  proceed = false;
			  if (err_count < settings["max_level_skip"]) {
				proceed = true;
			  }
			}
		}
    const done_clamped = Math.min(levels_done, meta['количество уровней']);
    updScanProgress(threadN, cidd, isNaN(done_clamped) ? levels_done : done_clamped, meta['количество уровней']);
  }
  if (stopped) {
    return "stopped";
  }
  console.log('сканирование завершено – форматирование данных');
  if (meta['количество предметов'].includes("?")) {
	meta['количество предметов'] = "~" + table.length;
  }
  if (table.length < meta['количество предметов']) {
  	console.warn(`${cidd['cid']}: Only ${table.length} out of ${meta['number of items']} learnables have been downloaded! (you might want to check your internet connection and retry)`);
	meta['количество предметов'] = `${table.length} из ${meta['number of items']}`;
  }
  const course_fields = [];
  if (has_learnable) {course_fields.push("Learnable")};
  if (has_definitions) {course_fields.push("Definition")};
  if (has_audio) {course_fields.push("Audio")};
  if (has_video) {course_fields.push("Video")};
  course_fields.push(...attributes);
  course_fields.push(...visible_info);
  course_fields.push(...hidden_info);
  if (settings["level_tags"]) {course_fields.push("Теги уровней")};
  if (settings["learnable_ids"]) {course_fields.push("Обучаемый идентификатор")};
  if (settings["learning_progress"]) {course_fields.push("Progress")};
  if (settings["learnable_meta"]) {course_fields.push("Обучаемая мета")};
  meta['поля курса'] = course_fields.join(" | ");
  let csv_data = table.map(row => {
		const line = [];
		if (has_learnable) {line.push(row[0])};
		if (has_definitions) {line.push(row[1])};
		if (has_audio) {line.push(row[2])};
		if (has_video) {line.push(row[3])};
		line.push(...row.slice(4, 4 + attributes.length));
		line.push(...row.slice(4 + settings["max_extra_fields"], 4 + settings["max_extra_fields"] + visible_info.length));
		line.push(...row.slice(4 + 2 * settings["max_extra_fields"], 4 + 2 * settings["max_extra_fields"] + hidden_info.length));
		if (settings["level_tags"]) {line.push(row[4 + 3 * settings["max_extra_fields"]])};
		if (settings["learnable_ids"]) {line.push(row[4 + 3 * settings["max_extra_fields"] + 1])};
		if (settings["learning_progress"]) {line.push(row[4 + 3 * settings["max_extra_fields"] + 1 + settings["learnable_ids"]])};
		if (settings["learnable_meta"]) {line.push(row[4 + 3 * settings["max_extra_fields"] + 1 + settings["learnable_ids"] + settings["learning_progress"]])};
		return line.join(`,`);
	}).join("\n") + "\n";
	if (ANKI_HEADERS) {
		let tags_col = course_fields.length;
		if (settings["learnable_ids"]) {tags_col--};
		if (settings["learning_progress"]) {tags_col--};
		if (settings["learnable_meta"]) {tags_col--};
		csv_data = "#separator:запятая\n" +
				 "#html:true\n" +
				 (settings["level_tags"] ? (`Столбец #tags:${tags_col}\n`) : ``) +
				 "#столбцы:" + course_fields.join(",") + "\n" +
				 csv_data;
	}
  const csv_encoded = 'data:text/csv;charset=utf-8,%EF%BB%BF' + encodeURIComponent(csv_data);
  let course_filename, course_folder;
  if (settings["course_metadata"]) {
	course_filename = `${meta['url name']} [${cidd['cid']}]`;
	course_folder = `${meta['url name']} от ${meta['author']} [${cidd['cid']}]/`;
  } else {
	course_filename = `${meta['url name']} от ${meta['author']} [${cidd['cid']}]`;
	course_folder = "";
  }
  if (settings["download_media"]) {
    console.log(`Медиа-файлы найдены в ${meta['url name']}[${cidd['cid']}]: ${course_media_urls.size}`);
  };
  file_queue.unshift([csv_encoded, `${course_folder}${course_filename}_(${meta['number of items'].toString()}).csv`]);
  if (settings["course_metadata"]) {
    file_queue.unshift([meta2txt(meta), `${course_folder}info.md`]);
    file_queue.unshift([meta['ava'], `${course_folder}${meta['author']}.${meta['ava'].split(".").slice(-1)}`]);
	file_queue.unshift([meta['thumbnail'], `${course_folder}${meta['url name']}.${meta['thumbnail'].split(".").slice(-1)}`]);
  }
  if (!settings["skip_media_download"]) {
	course_media_urls.forEach(url => {
		file_queue.push([url, `${course_folder}${course_filename}_media(${course_media_urls.size})/${UniqueDecodedFilename(url)}`]);
  	});
  }
	return "completed";
}
async function scanThread(threadN, batch_size) {
  let cidd;
  while (cidd = cidds.pop()) {
    if (cidd['domain'] === tabDomain) {
      const closingEvent = await scanCourse(cidd, threadN);
      if (closingEvent === "stopped") {
        console.log(`поток ${threadN} (cid: ${cidd['cid']}) — сканирование остановлено пользователем`);
        return "stopped";
      };
	  if (closingEvent === "unauthorised") {
        console.log(`поток ${threadN} (cid: ${cidd['cid']}) — пользователь не вошел в систему, сканирование прекращено`);
        return "unauthorised";
      };
    } else {
      console.warn(`${cidd} не соответствует домену вкладки загрузки ${tabDomain}`);
    }
    batch_done++;
    updBatchProgress(batch_done, batch_size, cidd);
  }
  removeScanBar(threadN);
}
async function batchDownload() {
	tabDomain = window.location.toString().split("/")[2];
	if (tabDomain !== 'community-courses.memrise.com') {
		alert("Расширение нужно использовать на community-courses.memrise.com");
		return -1;
	}
	const test_fetch = await fetch(fetchURL(tabDomain));
	if (!test_fetch.ok) {
	  if (test_fetch.status === 401) {
		  console.log("не авторизован - прекращение загрузки");
		  alert("Требуется вход в Memrise");
		  return "сканирование несанкционированное";
	  }
	}
  threads = [];
  batch_done = 0;
  file_queue = [];
  const batch_size = cidds.length;
  const progress_container = progressBarContainer();
  while (progress_container.firstChild) {progress_container.removeChild(progress_container.firstChild);}
  progress_container.classList.remove('stopped'); progress_container.classList.remove('error');
  document.querySelectorAll('div[id^="MemDump_progress-padding"]').forEach(element => {element.remove();});
  for (let threadCounter = 0; threadCounter < settings['parallel_download_limit'] && cidds.length > 0; threadCounter++) {
    threads.push(scanThread(threadCounter, batch_size));
  }
  updBatchProgress(batch_done, batch_size);
  const thread_res = await Promise.all(threads);
  if (thread_res.includes("unauthorised")) {
    console.log("все потоки сканирования остановлены");
    progress_container.classList.add('error');
    threads = undefined;
    return "сканирование несанкционированное";
  }
  if (thread_res.includes("stopped")) {
    console.log("все потоки сканирования остановлены");
    progress_container.classList.add('stopped');
    threads = undefined;
    return "сканирование остановлено";
  }
  console.log('Сканирование и форматирование завершены.');
  await sleep(500);
  updMediaProgress(0, file_queue.length);
  function mediaDownloadMessages(arg, sender, sendResponse) {
    if (arg.type === "coursedump_error") {
      console.warn(`произошла ошибка при загрузке файла ${arg.url} – ${arg.filename}`);
      console.error(arg.error);
      progress_container.classList.add('error');
    } else if (arg.type === "coursedump_progressMedia_upd") {
      updMediaProgress(arg.done, arg.todo);
    } else if (arg.type === "coursedump_mediaFinished") {
      if (arg.status === "done") {
        updMediaProgress("done");
        setTimeout(() => {
          if (settings['anki_import_prompt'] && confirm('Нужна помощь с импортом скачанных данных в Anki?')) {
            window.open('https://github.com/Eltaurus-Lt/CourseDump2022#-importing-into-anki', '_blank').focus();
          }
        }, 200);
      } else if (arg.status === "stopped") {
        console.log("остановлен во время загрузки файла");
        progress_container.classList.add('stopped');
      }
      chrome.runtime.onMessage.removeListener(mediaDownloadMessages);
      threads = undefined;
    }
  }
  chrome.runtime.onMessage.addListener(mediaDownloadMessages);
  chrome.runtime.sendMessage({
    type: "coursedump_downloadFiles",
    file_queue,
		maxThreads: settings["parallel_download_limit"]
  });
}
if (typeof cidds === 'undefined') {var cidds = []}
if (typeof batch_done === 'undefined') {var batch_done = 0}
if (typeof file_queue === 'undefined') {var file_queue = []}
if (typeof threads !== 'undefined') {
  alert('Скрипт уже выполняется на этой странице. Перезагрузите страницу, чтобы повторить');
} else {
  batchDownload();
}