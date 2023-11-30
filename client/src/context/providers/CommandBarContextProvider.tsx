import { memo, PropsWithChildren, useMemo, useState } from 'react';
import { CommandBarContext } from '../commandBarContext';
import {
  CommandBarActiveStepType,
  CommandBarItemGeneralType,
  CommandBarStepEnum,
} from '../../types/general';

type Props = {};

const CommandBarContextProvider = ({ children }: PropsWithChildren<Props>) => {
  const [focusedItem, setFocusedItem] = useState<{
    footerHint?: CommandBarItemGeneralType['footerHint'];
    footerBtns?: CommandBarItemGeneralType['footerBtns'];
  } | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [chosenStep, setChosenStep] = useState<CommandBarActiveStepType>({
    id: CommandBarStepEnum.INITIAL,
  });

  const currentStepContextValue = useMemo(() => ({ chosenStep }), [chosenStep]);

  const footerValuesContextValue = useMemo(() => {
    return {
      focusedItem,
    };
  }, [focusedItem]);

  const handlersContextValue = useMemo(() => {
    return {
      setFocusedItem,
      setChosenStep,
      setIsVisible,
    };
  }, []);

  const generalContextValue = useMemo(() => {
    return {
      isVisible,
    };
  }, [isVisible]);

  return (
    <CommandBarContext.Handlers.Provider value={handlersContextValue}>
      <CommandBarContext.General.Provider value={generalContextValue}>
        <CommandBarContext.CurrentStep.Provider value={currentStepContextValue}>
          <CommandBarContext.FooterValues.Provider
            value={footerValuesContextValue}
          >
            {children}
          </CommandBarContext.FooterValues.Provider>
        </CommandBarContext.CurrentStep.Provider>
      </CommandBarContext.General.Provider>
    </CommandBarContext.Handlers.Provider>
  );
};

export default memo(CommandBarContextProvider);
