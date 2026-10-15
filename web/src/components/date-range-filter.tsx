"use client";

import { useMemo } from "react";

import {
  DateRangePicker,
  DateRangePickerCalendar,
  DateRangePickerClear,
  DateRangePickerContent,
  DateRangePickerFooter,
  DateRangePickerGrid,
  DateRangePickerHeader,
  DateRangePickerPresets,
  DateRangePickerSelection,
  DateRangePickerTrigger,
  useDateRangePicker,
} from "@/components/motion/date-range-picker";
import type { DateRangePreset } from "@/components/motion/date-range-picker/types";

type DateRangeFilterProps = {
  startDate: string;
  endDate: string;
  onChange: (startDate: string, endDate: string) => void;
};

function formatDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return formatDay(date);
}

function SelectionText() {
  const { value } = useDateRangePicker();
  if (!value) {
    return <>选择开始日期</>;
  }
  if (!value.to) {
    return <>选择结束日期</>;
  }
  const days = Math.round((Date.parse(value.to) - Date.parse(value.from)) / 86_400_000) + 1;
  return <>已选 {days} 天</>;
}

/** 日期范围筛选：beUI 的日期范围选择器（弹出层从按钮形变展开），带常用快捷范围 */
export function DateRangeFilter({ startDate, endDate, onChange }: DateRangeFilterProps) {
  const today = formatDay(new Date());
  const presets = useMemo<DateRangePreset[]>(
    () => [
      { label: "今天", value: { from: today, to: today } },
      { label: "最近 7 天", value: { from: daysAgo(6), to: today } },
      { label: "最近 30 天", value: { from: daysAgo(29), to: today } },
      { label: "最近 90 天", value: { from: daysAgo(89), to: today } },
    ],
    [today],
  );

  return (
    <DateRangePicker
      label="日期范围"
      locale="zh-CN"
      max={today}
      presets={presets}
      closeOnSelect
      value={startDate ? { from: startDate, to: endDate || startDate } : null}
      onValueChange={(range) => onChange(range?.from ?? "", range?.to ?? "")}
    >
      <DateRangePickerTrigger placeholder="选择日期范围" endPlaceholder="选择结束" className="h-10 min-w-[200px] bg-field hover:border-border-strong hover:bg-field-hover" />
      <DateRangePickerContent>
        <DateRangePickerCalendar className="w-full rounded-none border-0">
          <DateRangePickerHeader />
          <DateRangePickerGrid />
          <DateRangePickerFooter>
            <div className="flex items-center justify-between gap-2">
              <DateRangePickerSelection>
                <SelectionText />
              </DateRangePickerSelection>
              <DateRangePickerClear aria-label="清除日期范围">清除</DateRangePickerClear>
            </div>
            <DateRangePickerPresets />
          </DateRangePickerFooter>
        </DateRangePickerCalendar>
      </DateRangePickerContent>
    </DateRangePicker>
  );
}
