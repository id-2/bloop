import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Sentry from '@sentry/react';
import { useNavigate } from 'react-router-dom';
import { FullResult, ResultClick } from '../../types/results';
import { mapFileResult, mapRanges } from '../../mappers/results';
import {
  ConversationMessage,
  FullResultModeEnum,
  SearchType,
} from '../../types/general';
import useAppNavigation from '../../hooks/useAppNavigation';
import ResultModal from '../ResultModal';
import { useSearch } from '../../hooks/useSearch';
import { FileSearchResponse, NLSnippet } from '../../types/api';
import ErrorFallback from '../../components/ErrorFallback';
import { getHoverables } from '../../services/api';
import { ResultsPreviewSkeleton } from '../Skeleton';
import SemanticSearch from '../../components/CodeBlock/SemanticSearch';
import { DeviceContext } from '../../context/deviceContext';
import PageHeader from '../../components/ResultsPageHeader';
import Conversation from './Conversation';

type Props = {
  query: string;
};

let prevEventSource: EventSource | undefined;

const ResultsPage = ({ query }: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const { deviceId, apiUrl } = useContext(DeviceContext);
  const [isLoading, setIsLoading] = useState(true);
  const [conversation, setConversation] = useState<ConversationMessage[]>([
    { author: 'user', text: query, isLoading: false },
  ]);
  const [searchId, setSearchId] = useState('');
  const [mode, setMode] = useState<FullResultModeEnum>(
    FullResultModeEnum.MODAL,
  );
  const [scrollToLine, setScrollToLine] = useState<string | undefined>(
    undefined,
  );
  const [currentlyViewedSnippets, setCurrentlyViewedSnippets] = useState(0);
  const [openResult, setOpenResult] = useState<FullResult | null>(null);
  const { navigateRepoPath } = useAppNavigation();
  const { searchQuery: fileModalSearchQuery, data: fileResultData } =
    useSearch<FileSearchResponse>();
  const navigateBrowser = useNavigate();

  const onResultClick = useCallback<ResultClick>((repo, path, lineNumber) => {
    setScrollToLine(lineNumber ? lineNumber.join('_') : undefined);
    if (path) {
      fileModalSearchQuery(
        `open:true repo:${repo} path:${path}`,
        0,
        false,
        SearchType.REGEX,
      );
    } else {
      navigateRepoPath(repo);
    }
  }, []);

  const handleModeChange = useCallback((m: FullResultModeEnum) => {
    setMode(m);
  }, []);

  const onResultClosed = useCallback(() => {
    setOpenResult(null);
  }, [mode]);

  useEffect(() => {
    if (fileResultData) {
      setOpenResult(mapFileResult(fileResultData.data[0]));
      navigateBrowser({
        search: scrollToLine
          ? '?' +
            new URLSearchParams({
              scroll_line_index: scrollToLine.toString(),
            }).toString()
          : '',
      });
      getHoverables(
        fileResultData.data[0].data.relative_path,
        fileResultData.data[0].data.repo_ref,
      ).then((data) => {
        setOpenResult((prevState) => ({
          ...prevState!,
          hoverableRanges: mapRanges(data.ranges),
        }));
      });
    }
  }, [fileResultData]);

  const makeSearch = useCallback((question: string) => {
    setIsLoading(true);
    prevEventSource?.close();
    const eventSource = new EventSource(
      `${apiUrl.replace(
        'https:',
        '',
      )}/answer?q=${question}&user_id=${deviceId}`,
    );
    prevEventSource = eventSource;
    setConversation((prev) => [...prev, { author: 'server', isLoading: true }]);
    let i = 0;
    eventSource.onmessage = (ev) => {
      if (ev.data === '[DONE]') {
        eventSource.close();
        setConversation((prev) => {
          const newConversation = prev.slice(0, -1);
          const lastMessage = {
            ...prev.slice(-1)[0],
            isLoading: false,
          };
          return [...newConversation, lastMessage];
        });
        prevEventSource = undefined;
      } else {
        const newData = JSON.parse(ev.data);

        if (i === 0) {
          if (newData.Err) {
            setIsLoading(false);
            setConversation((prev) => {
              const newConversation = prev.slice(0, -1);
              const lastMessage = {
                ...prev.slice(-1)[0],
                isLoading: false,
                error: newData.Err,
              };
              return [...newConversation, lastMessage];
            });
          } else {
            setIsLoading(false);
            setSearchId(newData?.query_id);
            setConversation((prev) => {
              const newConversation = prev.slice(0, -1);
              const lastMessage = {
                ...prev.slice(-1)[0],
                isLoading: true,
                snippets:
                  newData?.snippets?.map((item: NLSnippet) => ({
                    path: item.relative_path,
                    code: item.text,
                    repoName: item.repo_name,
                    lang: item.lang,
                    line: item.start_line,
                  })) || [],
              };
              return [...newConversation, lastMessage];
            });
          }
        } else {
          setConversation((prev) => {
            const newConversation = prev.slice(0, -1);
            const lastMessage = {
              ...prev.slice(-1)[0],
              text: (prev.slice(-1)[0].text || '') + newData.Ok,
            };
            return [...newConversation, lastMessage];
          });
        }
        i++;
      }
    };
    eventSource.onerror = (err) => {
      console.error('EventSource failed:', err);
      setIsLoading(false);
      setConversation((prev) => [
        ...prev,
        {
          author: 'server',
          isLoading: false,
          error: 'Sorry, something went wrong',
        },
      ]);
    };
  }, []);

  useEffect(() => {
    makeSearch(query);
  }, [query]);

  const lastServerResponse = useMemo(() => {
    const serverResponses = conversation.filter((m) => m.author === 'server');
    return serverResponses[serverResponses.length - 1];
  }, [conversation]);

  useEffect(() => {
    setCurrentlyViewedSnippets(conversation.length - 1);
  }, [lastServerResponse]);

  const handleNewMessage = useCallback(
    (message: string) => {
      setConversation((prev) => [
        ...prev,
        { author: 'user', text: message, isLoading: false },
      ]);
      makeSearch(message);
    },
    [makeSearch],
  );

  return (
    <>
      <div
        className="p-8 flex-1 overflow-x-auto mx-auto max-w-6.5xl box-content"
        ref={ref}
      >
        <PageHeader
          resultsNumber={
            conversation[currentlyViewedSnippets]?.snippets?.length || 0
          }
          loading={isLoading}
        />
        {isLoading ? (
          <ResultsPreviewSkeleton />
        ) : !!conversation[currentlyViewedSnippets]?.snippets?.length ? (
          <SemanticSearch
            snippets={conversation[currentlyViewedSnippets].snippets || []}
            onClick={onResultClick}
          />
        ) : null}
      </div>
      <Conversation
        conversation={conversation}
        onNewMessage={handleNewMessage}
        onViewSnippetsClick={setCurrentlyViewedSnippets}
        currentlyViewedSnippets={currentlyViewedSnippets}
      />

      {openResult ? (
        <ResultModal
          result={openResult as FullResult}
          onResultClosed={onResultClosed}
          mode={mode}
          setMode={handleModeChange}
        />
      ) : (
        ''
      )}
    </>
  );
};
export default Sentry.withErrorBoundary(ResultsPage, {
  fallback: (props) => <ErrorFallback {...props} />,
});
