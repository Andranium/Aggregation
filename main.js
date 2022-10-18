(async () => {
    try {
        const { href } = window.location;

        const splittedUrl = href.split('/');

        splittedUrl.pop();

        const data = await fetch(pathBuilder(splittedUrl, 'data')).then(res => res.json());

        const captions = await fetch(pathBuilder(splittedUrl,'captions')).then(res => res.json());

        const groupBy = captions.filter(caption => caption.group_by);

        console.log(`Изначальные данные полученные с бэка: `, data);

        console.log(`Кепшны, у кепшнов есть полезная инфа для работы с данными, к примеру aggregation_function:`, captions);

        const aggregatedData = aggregation(data, captions, groupBy);

        console.log(`Тут у нас начинается агрегация и остаются агрегированные значения:`, aggregatedData);

        const mappedData = objectMapping(aggregatedData, captions);

        console.log(`Маппинг полей, маппим в соответствии кепшна:`, mappedData);

        const series = seriesFormatter(mappedData);

        console.log(`И в конце уже меняем формат данных для вывода на таблицу:`, series);

        var options = {
            chart: {
                type: 'bar',
                height: 500,
                width: '100%',
            },
            series: series,
            yaxis: {
                logarithmic: true
            }
        }

        var chart = new ApexCharts(document.querySelector("#chart"), options);

        chart.render();

    } catch (e) {
        throw `Error occurred: ${e}`;
    }
})();

function pathBuilder(arrayUrl, fileName) {
    const clonedArray = [].concat(arrayUrl);

    clonedArray.push(`${fileName}.json`);

    return clonedArray.join('/');
}

function seriesFormatter(mappedData) {
    let data = [];
    let names = [];

    const length = mappedData[0].metric.length;

    for (let i = 0; i < length; i++) {
        data[i] = mappedData.map((item) => {
            const { title, value } = item.metric[i];

            if (!names.includes(title)) names.push(title);

            return value === 0 ? null : value;
        });
    }

    return data.map((item, index) => ({
        name: names[index] || '',
        data: item,
    }));
}

function objectMapping(data, captions) {
    const array = [];

    data.forEach(node => {
        const item = {};

        for(const key in node) {
            const currentCaption = captions.find(
                (caption) => caption.json_key === key,
            );

            if (!currentCaption) continue;

            let element;

            const {
                json_key,
                key: optionKey,
                title,
                style,
            } = currentCaption;

            element =
                typeof node[json_key] !== 'object' ? {} : node[json_key];

            const currentElement = {
                ...element,
                json_key,
                title: title ?? '',
                style,
            };

            if (!node[json_key]) currentElement.value = null;

            if (optionKey in item) {
                const existingElement = item[optionKey];

                if (Array.isArray(existingElement)) {
                    existingElement.push(currentElement);
                } else {
                    item[optionKey] = [existingElement, currentElement];
                }
            } else {
                item[optionKey] =
                    typeof node[json_key] === 'object'
                        ? [currentElement]
                        : node[json_key];
            }
        }

        array.push(item);
    })

    return array;
}

function aggregation(nodes, captions, group_by, dateFrom, dateTo) {
    const groupedBy =
        typeof group_by === 'object' ? group_by[0].json_key : group_by; // Ключ по которому будет сортироваться/группироваться массив

    const regexp = new RegExp(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

    let period;

    if (dateFrom && dateTo) {
        const YEAR = 31556952000;
        const MONTH = 2629746000;

        dateFrom = new Date(dateFrom);
        dateTo = new Date(dateTo);

        const dateInterval = dateTo - dateFrom;

        if (dateInterval <= MONTH) period = 'day';
        else if (dateInterval <= YEAR) period = 'month-year';
    }

    // Находим агрегации из captions и убираем нуллы
    const aggregations = captions
        .map((caption) => ({
            key: caption.json_key,
            fn: caption.aggregation_function,
        }))
        .filter((aggregation) => aggregation.fn);

    if (!aggregations.length) return nodes;

    // Сортируем ноды по строке, либо по дате
    nodes = nodes.sort((a, b) => {
        const dateA = new Date(a[groupedBy]);
        const dateB = new Date(b[groupedBy]);

        const isDate = regexp.test(a[groupedBy] && b[groupedBy]);

        switch (typeof a[groupedBy]) {
            case 'string': {
                return isDate
                    ? dateA - dateB
                    : a[groupedBy].localeCompare(b[groupedBy]);
            }
        }
    });

    let addedElementIndex = 0; // Индекс группы нодов внутри массива
    let sum = {};
    let groups = [];

    nodes = nodes.reduce((acc, node, index) => {
        const nextNode = nodes[index + 1]; // След. элемент массива

        const isDate = regexp.test(node[groupedBy]);

        let [nodeYear, nodeMonth, nodeDay] = dateDestructor(
            node,
            groupedBy,
            isDate,
        );
        let [nextNodeYear, nextNodeMonth, nextNodeDay] = dateDestructor(
            nextNode,
            groupedBy,
            isDate,
        );

        let monthA = isDate ? `${nodeYear}-${nodeMonth}` : null;
        let monthB = isDate && nextNode ? `${nextNodeYear}-${nextNodeMonth}` : null;

        if (period === 'day' && isDate) {
            monthA += `-${nodeDay}`;
            monthB += `-${nextNodeDay}`;
        }

        // Проверяем данные, если дата, то группируем по месяцам
        const condition = isDate
            ? nextNode && monthA !== monthB
            : nextNode && node[groupedBy] !== nextNode[groupedBy];

        // Создаём группы внутри массива, структура группы [[...], [...]]
        let currentElement = acc[addedElementIndex];

        if (!currentElement) acc[addedElementIndex] = [];

        acc[addedElementIndex].push(node);

        if ((nextNode && node[groupedBy] !== nextNode[groupedBy]) || !nextNode)
            groups.push(acc[addedElementIndex]);

        for (const aggregation of aggregations) {
            // Проходим через все функции агрегации
            const { key, fn } = aggregation; // Берём ключ и саму функцию

            switch (fn) {
                case 'SUM': {
                    if (typeof node[key] === 'string' || !node[key]) continue;

                    // агрегация SUM
                    sumCalculation(node, key);

                    const sumCondition = isDate
                        ? nextNode && monthA !== monthB
                        : nextNode && nextNode[groupedBy] !== node[groupedBy];

                    // Если группа у нас собралась, меняем значение на 0 для нового рассчёта
                    if (sumCondition) {
                        sum[key] = 0;
                        sum.superscript = 0;
                    }

                    break;
                }

                case 'AVG': {
                    if (typeof node[key] === 'string' || !node[key]) continue;

                    sumCalculation(node, key);

                    // Группа
                    const currentGroup = acc[addedElementIndex];

                    // Берём длину группы
                    const currentGroupLength = currentGroup ? currentGroup.length : 1;

                    // Если длинна группы === длины нодов, значит у нас одна группа, рассчитаем AVG
                    if (currentGroupLength === nodes.length)
                        avgCalculation(node, key, currentGroupLength);

                    let nextElement =
                        (nextNode && nextNode[groupedBy]) ||
                        !(nextNode && nextNode[groupedBy]);

                    const sumCondition = isDate
                        ? (nextNode && monthA !== monthB) || !monthB
                        : nextElement !== node[groupedBy];

                    // Если группа у нас собралась, меняем значение на 0 для нового рассчёта
                    if (sumCondition) {
                        avgCalculation(node, key, currentGroupLength);

                        sum[key] = 0;
                        sum.superscript = 0;
                    }
                    break;
                }
            }
        }

        if (condition || !nextNode) {
            // Оставляем из группы только последний элемент
            let currentGroup = acc[addedElementIndex];

            acc[addedElementIndex] = currentGroup[currentGroup.length - 1];

            // Меняем счётчик при смене группы
            addedElementIndex++;
        }

        return acc;
    }, []);

    // Helper functions
    function sumCalculation(node, key) {
        const isObject = typeof node[key] === 'object';
        const hasSuperscript = isObject && 'superscript' in node[key];

        if (!(key in sum) || !sum[key]) sum[key] = 0; // Если ещё не добавлен ключ к объекту, добавляем и задаём 0

        if (hasSuperscript && !sum.superscript) sum.superscript = 0; // Если ещё не добавлен суперскрипт, добавляем и задаём 0

        sum[key] += isObject ? node[key].value : node[key];

        if (hasSuperscript) {
            sum.superscript += node[key].superscript.value;

            node[key].superscript.value = sum.superscript;
        }

        if (isObject) node[key] = { ...node[key], value: sum[key] };
        else node[key] = sum[key];
    }

    function avgCalculation(node, key, groupLength) {
        const isObject = typeof node[key] === 'object';
        const hasSuperscript = isObject && 'superscript' in node[key];
        const value = sum[key] / groupLength;
        const superScriptValue = sum.superscript / groupLength;

        if (!value) return;

        if (isObject) node[key] = { ...node[key], value };
        else node[key] = value;

        if (hasSuperscript) node[key].superscript.value = superScriptValue;
    }

    function dateDestructor(element, groupedBy, isDate) {
        if (!(element && element[groupedBy]) || !isDate) return [];

        return element[groupedBy].split('-');
    }

    return nodes;
};
